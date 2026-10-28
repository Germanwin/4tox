/* mp-midround.js — замер середины партии: три игрока по 200 жителей, лесопилки,
   гуляющие и три дружины, которые реально идут бить чужую ратушу.

   Это не проверка правил по отдельности (для них есть mp-load-work.js,
   mp-load-combat.js, mp-active-window.js), а ОДНО окно комнаты, в котором
   одновременно происходят все дорогие вещи: 120 лагерей лесоруба с 360
   рабочими, 180 гуляющих, 60 воинов в шести военных лагерях, три команды
   постройки через runtime.submit и три дружины, которые идут каждая на
   чужую ратушу (приказы через Commands.apply).

   Мир — настоящий: Simulation.create({size:192, players:3}), остров из
   worldgen, стартовые деревни на своих spawnSites. Ничего не подменяется,
   кроме наполнения: лагеря ставятся Buildings.canPlace + settle, вокруг них
   детерминированно добавляются деревья, жители — Villagers.blank + Session.hire.
   Так же, как это делает игра, только без браузера и без картинки.

   Комната — настоящий RoomRuntime: журнал, fsync, snapshotEvery, checkpointEvery.
   Часы и таймеры по умолчанию свои (pump), поэтому ticks/s и snapshots/s —
   это то, что комната правда выдаёт на стену. Для детерминированного прогона
   без ожидания есть --fast: часы-заглушка и ручные тики, как в
   mp-active-window.js.

     node game/tools/tests/mp-midround.js
     node game/tools/tests/mp-midround.js --seconds 60 --entities 200
     node game/tools/tests/mp-midround.js --realtime --seconds 30
     node game/tools/tests/mp-midround.js --quick          # 12 с, 3x60, мягкие гейты
     node game/tools/tests/mp-midround.js --fast           # без ожидания стены

   Отчёт печатается JSON'ом и пишется в game/tools/out/mp-midround-<время>.json.
   Код возврата: 0 — MIDROUND PASS, 1 — гейт не прошёл (или упало).

   Гейты по умолчанию (полный прогон):
     ticks/s >= 18, snapshots/s >= 9, p95 интервала снимков < 150 мс,
     p99 шага < 45 мс, checkpoint < 30 МБ (и хотя бы один),
     ни одного fault комнаты, хотя бы один удар/урон по ратуше,
     хотя бы одна постройка применена.
   --quick ослабляет только числа (10/5/250/80/30 МБ) и печатает их в отчёте:
   мягкий гейт — это явное число, а не молча выключенная проверка. */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { loadEngine, makeSim } = require('./load-engine');
const { RoomRuntime } = require('../../server/room-runtime.js');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const OUT_DIR = path.join(ROOT, 'game', 'tools', 'out');
const SEED = 'тихая-пойма-123';
const ROOM_ID = 'MIDROUND';
const MB = 1024 * 1024;

function argNum(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : def;
}
function hasFlag(name) { return process.argv.includes('--' + name); }
function nowMs() { return Number(process.hrtime.bigint()) / 1e6; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function pct(arr, p) {
  if (!arr || !arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  return +s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))].toFixed(3);
}
function maxOf(arr) {
  if (!arr || !arr.length) return null;
  return +Math.max.apply(null, arr).toFixed(3);
}
function round2(n) { return Math.round(n * 100) / 100; }
function bytesMb(n) { return round2((n || 0) / MB); }

/* Детерминированный порядок обхода клеток: сначала близкие к центру, при
   равенстве — меньший y, потом x. Один и тот же мир даёт одни и те же места
   при каждом запуске, а не «примерно вокруг». */
function candidatesAround(world, cx, cy, step) {
  const out = [];
  const s = Math.max(1, step || 2);
  for (let y = 3; y < world.height - 4; y += s) {
    for (let x = 3; x < world.width - 4; x += s) {
      out.push({ x: x, y: y, d: Math.hypot(x + 1.5 - cx, y + 1.5 - cy) });
    }
  }
  out.sort((a, b) => (a.d - b.d) || (a.y - b.y) || (a.x - b.x));
  return out;
}

/* Наполнение мира: 40 лагерей лесоруба и 2 военных лагеря на игрока, деревья
   вокруг лагерей, 120 рабочих, 60 гуляющих, 20 воинов. Возвращает всё, что
   понадобится отчёту, и НЕ трогает runtime — комната получит этот мир целиком
   после start(). */
function stageWorld(g, perPlayer) {
  const sim = makeSim({ size: 192, players: 3 });
  const world = sim.state.world;
  const B = g.Buildings;
  const V = g.Villagers;
  const T = g.WorldGen.T;

  for (const town of world.towns) town.logs = 10000;

  const campsPer = Math.max(4, Math.min(50, Math.round(perPlayer * 0.2)));
  const warriorsPer = Math.max(4, Math.min(40, Math.round(perPlayer * 0.1)));
  const civPer = Math.max(0, perPlayer - campsPer * 3 - warriorsPer);
  const campTreesPer = 8;

  const camps = [[], [], []];
  const warcamps = [[], [], []];
  const placed = [];
  let nextBuildId = 1000;

  function centerOf(b) {
    const fp = B.footprint(b.rot, b.type);
    return { x: b.x + fp.w / 2, y: b.y + fp.h / 2 };
  }
  function overlapsAny(b) {
    const A = B.bounds(b);
    for (let i = 0; i < sim.state.buildings.length; i++) {
      const C = B.bounds(sim.state.buildings[i]);
      if (A.x0 < C.x1 && C.x0 < A.x1 && A.y0 < C.y1 && C.y0 < A.y1) return true;
    }
    return false;
  }
  function farEnough(b, minD) {
    const c = centerOf(b);
    for (let i = 0; i < placed.length; i++) {
      const d = centerOf(placed[i]);
      if (Math.hypot(c.x - d.x, c.y - d.y) < minD) return false;
    }
    return true;
  }
  function grassAt(b, fp) {
    for (let j = 0; j < fp.h; j++) {
      for (let i = 0; i < fp.w; i++) {
        if (world.tile[(b.y + j) * world.width + (b.x + i)] !== T.GRASS) return false;
      }
    }
    return true;
  }

  /* Место ставится по тем же правилам, что и в игре: canPlace с разрешённой
     расчисткой (деревья и камни можно убрать), без охраны выходов (соседние
     постройки в этой сцене расставлены заранее и не должны блокировать друг
     друга) и с settle, которая правда убирает лес с пятна и двора. */
  let placements = 0;
  function placeNear(type, cand, owner, list, minD, minTown) {
    const fp = B.footprint(0, type);
    for (let k = 0; k < cand.length; k++) {
      const c = cand[k];
      if (c.d < minTown) continue;
      if (c.x < 1 || c.y < 1 || c.x + fp.w >= world.width - 1 || c.y + fp.h >= world.height - 1) continue;
      const b = B.make({
        type: type, variant: 'a', rot: 90, x: c.x, y: c.y,
        owner: owner, town: owner, id: 'p' + owner + ':mid' + (nextBuildId++)
      });
      if (overlapsAny(b)) continue;
      if (!farEnough(b, minD)) continue;
      if (!grassAt(b, fp)) continue;
      const chk = B.canPlace(world, sim.state.buildings, b, {
        clearable: true, requireClear: false, protectExits: false, villagers: []
      });
      if (!chk.ok) continue;
      B.settle(world, b);              // пятно и двор чистые: лес срублен
      sim.state.buildings.push(b);
      placed.push(b);
      list.push(b);
      placements++;
      return b;
    }
    return null;
  }

  for (let owner = 0; owner < 3; owner++) {
    const town = world.towns[owner];
    const c = B.center(town.townhall);
    const cand = candidatesAround(world, c.x, c.y, 2);
    for (let k = 0; k < 2; k++) {
      const camp = placeNear('warcamp', cand, owner, warcamps[owner], 9, 14);
      if (!camp) throw new Error('нет места военному лагерю: игрок ' + owner);
    }
    /* Лагеря лесоруба — не вплотную к ратуше: в середине партии лес уже
       вырублен вокруг деревни, и рабочие живут у дальних делянок. Это ещё и
       честная сцена для боя: у ратуши нет чужого лагеря, который бойцы
       выберут целью раньше самой ратуши. */
    for (let k = 0; k < campsPer; k++) {
      const camp = placeNear('lumbercamp', cand, owner, camps[owner], 8, 22);
      if (!camp) throw new Error('нет места лагерю лесоруба: игрок ' + owner + ', №' + k);
    }
  }
  B.touch(world);

  /* Лес вокруг лагерей. Мир уже настоящий, но 120 лагерей могли встать на
     полянах без леса в радиусе выбора, а рабочий без дерева — это стоячий
     житель. Поэтому к каждому лагерю добавляется своё кольцо: клетка травы,
     не пятно и не двор постройки, у дерева минимум две свободные стороны
     (иначе к стволу нет подхода). objectTotal пересчитывается, индекс деревьев
     сбрасывается — иначе Villagers.treesNear не увидит новых стволов. */
  const solid = V.blockedMap(world, sim.state.buildings);
  const treeBlocked = Object.create(null);
  for (let i = 0; i < sim.state.buildings.length; i++) {
    const cover = B.coverCells(sim.state.buildings[i], 1);
    for (let j = 0; j < cover.length; j++) treeBlocked[cover[j].x + ',' + cover[j].y] = 1;
  }
  let nextTreeId = world.objectTotal || 0;
  const treeIdStart = nextTreeId;
  const treeCounts = [];
  let treesAdded = 0;
  const NB4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  function canPutTree(x, y) {
    if (x < 1 || y < 1 || x >= world.width - 1 || y >= world.height - 1) return false;
    if (world.tile[y * world.width + x] !== T.GRASS) return false;
    if (solid[y * world.width + x]) return false;
    if (treeBlocked[x + ',' + y]) return false;
    let open = 0;
    for (let d = 0; d < NB4.length; d++) {
      const nx = x + NB4[d][0], ny = y + NB4[d][1];
      if (nx < 0 || ny < 0 || nx >= world.width || ny >= world.height) continue;
      if (world.isLand[ny * world.width + nx] && !solid[ny * world.width + nx]) open++;
    }
    return open >= 2;
  }
  function putTree(x, y) {
    world.objects.push({
      kind: 'tree', variant: 'oak', x: x + 0.5, y: y + 0.5,
      scale: 1, phase: 0, id: nextTreeId++
    });
    solid[y * world.width + x] = 1;
    treeBlocked[x + ',' + y] = 1;
    treesAdded++;
  }
  for (let owner = 0; owner < 3; owner++) {
    for (let ci = 0; ci < camps[owner].length; ci++) {
      const camp = camps[owner][ci];
      const fp = B.footprint(camp.rot, camp.type);
      const cx = camp.x + fp.w / 2, cy = camp.y + fp.h / 2;
      let made = 0, guard = 0;
      for (let r = 3; r <= 9 && made < campTreesPer && guard < 4000; r++) {
        for (let dy = -r; dy <= r && made < campTreesPer && guard < 4000; dy++) {
          for (let dx = -r; dx <= r && made < campTreesPer && guard < 4000; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            guard++;
            const x = Math.round(cx + dx), y = Math.round(cy + dy);
            if (!canPutTree(x, y)) continue;
            putTree(x, y);
            made++;
          }
        }
      }
      treeCounts.push(made);
    }
  }
  world.objectTotal = nextTreeId;
  world._treeIndex = null;
  world._villagerBlocked = null;
  world._villagerAreas = null;
  world._combatCells = null;
  world._removedHexCache = null;

  /* Жители. id с 30000, чтобы не столкнуться со стартовыми (1..2003) и чтобы
     было видно в отладке, что это наполнение сцены. */
  let nextVillagerId = 30000;
  const usedSpawn = Object.create(null);
  function cellFreeForSpawn(x, y) {
    if (x < 0 || y < 0 || x >= world.width || y >= world.height) return false;
    if (world.tile[y * world.width + x] !== T.GRASS) return false;
    if (solid[y * world.width + x]) return false;
    if (treeBlocked[x + ',' + y]) return false;
    return true;
  }
  function spawnNear(cx, cy, radius) {
    for (let r = 1; r <= (radius || 10); r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = Math.round(cx + dx), y = Math.round(cy + dy);
          if (!cellFreeForSpawn(x, y)) continue;
          const key = x + ',' + y;
          if (usedSpawn[key]) continue;
          usedSpawn[key] = 1;
          return { x: x + 0.5, y: y + 0.5 };
        }
      }
    }
    return null;
  }
  const workers = [], civilians = [], warriors = [];
  let hired = 0;
  function newVillager(x, y, owner) {
    const v = V.blank(world, {
      id: nextVillagerId, index: nextVillagerId, rngKey: nextVillagerId,
      x: x, y: y, owner: owner, town: owner,
      avoid: [], buildings: sim.state.buildings
    });
    nextVillagerId++;
    v.avoid = [];
    v.path = null;
    v.anchor = { x: x, y: y };
    sim.state.villagers.push(v);
    return v;
  }

  for (let owner = 0; owner < 3; owner++) {
    const town = world.towns[owner];
    const tc = B.center(town.townhall);
    for (let ci = 0; ci < camps[owner].length; ci++) {
      const camp = camps[owner][ci];
      const slots = B.yardSlots(camp);
      const fp = B.footprint(camp.rot, camp.type);
      const cxc = camp.x + fp.w / 2, cyc = camp.y + fp.h / 2;
      /* Смена в середине партии уже идёт: часть рабочих рубит, часть ещё
         берёт топор у лагеря. Фаза рубки у каждого своя (0..5 с), поэтому
         деревья падают не залпом, а вразнобой, и планировщик не получает
         несколько сотен запросов в один тик. Это свойство СЦЕНЫ, а не
         ослабление замера: в реальной середине партии люди тоже находятся в
         разных точках цикла, а не начинают ходку одновременно. */
      for (let k = 0; k < 3; k++) {
        const gang = owner * 977 + ci * 3 + k;
        let staged = false;
        if (k < 2) {
          const trees = V.treesNear(world, cxc, cyc, 8, null);
          for (let ti = 0; ti < trees.length && !staged; ti++) {
            const tree = trees[ti];
            if (tree.mark) continue;
            const stands = V.standCells(world, solid, tree, cxc, cyc);
            for (let si = 0; si < stands.length && !staged; si++) {
              const st = stands[si];
              const key = st.cx + ',' + st.cy;
              if (usedSpawn[key]) continue;
              usedSpawn[key] = 1;
              const v = newVillager(st.x, st.y, owner);
              const r = g.Session.hire(camp, v, sim.state.villagers);
              if (!r.ok) throw new Error('наём не удался: ' + r.reason);
              V.mark(v, tree);
              v.tree = tree;
              v.goal = { x: st.x, y: st.y };
              v.close = true;
              v.path = null;
              v.state = 'chop';
              v.chopT = ((gang * 0.6180339887498949) % 1) * (V.CHOP_TIME - 0.25);
              v.hits = Math.floor(v.chopT / V.CHOP_HIT_EVERY);
              v.carrying = false;
              hired++;
              workers.push(v);
              staged = true;
            }
          }
        }
        if (staged) continue;
        /* Не нашлось дерева/места под стволом — тогда обычный заход: рабочий
           стоит на своём месте двора и берёт топор со своим замахом. */
        const slot = slots[k] || slots[0];
        const sp = slot ? { x: slot.x, y: slot.y } :
          (spawnNear(cxc, cyc, 10) || { x: camp.x + 2.5, y: camp.y + 2.5 });
        const v = newVillager(sp.x, sp.y, owner);
        const r = g.Session.hire(camp, v, sim.state.villagers);
        if (!r.ok) throw new Error('наём не удался: ' + r.reason);
        if (slot) {
          v.spot = slot;
          v.spotTrip = true;
          v.state = 'take';
          v.path = null;
          v.hold = 0.05 + ((gang * 7) % 15) * 0.33;
          v.intoYard = false;
          v.exitYard = false;
        }
        hired++;
        workers.push(v);
      }
    }
    for (let k = 0; k < civPer; k++) {
      const a = k * 2.399963229728653 + 0.4;
      const rr = 26 + (k % 10) * 3;
      const sp = spawnNear(tc.x + Math.cos(a) * rr, tc.y + Math.sin(a) * rr, 10) ||
        { x: tc.x + 0.5, y: tc.y + 0.5 };
      const v = newVillager(sp.x, sp.y, owner);
      v.state = 'wander';
      v.anchor = { x: v.x, y: v.y };
      civilians.push(v);
    }
    const perCamp = Math.ceil(warriorsPer / 2);
    for (let wi = 0; wi < warcamps[owner].length; wi++) {
      const camp = warcamps[owner][wi];
      const cells = B.patrolCells(camp);
      if (cells.length < perCamp) throw new Error('в лагере мало клеток кольца');
      for (let k = 0; k < perCamp; k++) {
        const cell = cells[k];
        const v = newVillager(cell.x + 0.5, cell.y + 0.5, owner);
        v.warrior = true;
        v.maxHp = 25;
        v.hp = 25;
        v.warcamp = camp;
        v.state = 'patrol';
        v.anchor = { x: v.x, y: v.y };
        warriors.push(v);
      }
    }
  }
  world._villagers = sim.state.villagers;
  world._buildings = sim.state.buildings;
  g.Combat.init(world, sim.state.buildings, sim.state.villagers);

  return {
    sim: sim, world: world,
    camps: camps, warcamps: warcamps,
    workers: workers, civilians: civilians, warriors: warriors,
    perPlayer: perPlayer, campsPer: campsPer, warriorsPer: warriorsPer,
    civPer: civPer, hired: hired,
    treesAdded: treesAdded, treeIdStart: treeIdStart,
    treeCounts: treeCounts, campTreesPer: campTreesPer,
    placements: placements,
    startingVillagers: 9
  };
}

/* --------------------------------------------------------------- комната -- */

function freshRoomStats() {
  return {
    ticks: 0, snapshots: 0, commandsAccepted: 0, commandsApplied: 0,
    commandsRejected: 0, commandsExpired: 0, faults: 0, stepMs: 0,
    ioMs: 0, maxDebtMs: 0, overloaded: false, slowTicks: 0
  };
}

function stopPump(runtime) {
  if (runtime.timer) {
    try { runtime.clock.clearTimeout(runtime.timer); } catch (e) { /* уже нет */ }
    runtime.timer = null;
  }
  if (runtime.status === 'running') runtime.status = 'suspended';
}

/* Поиск места под дом для команды build. Правила те же, что у команды:
   GameplayConfig.buildSite (clearable:false, requireClear:true) и живые
   жители. Дополнительно требуем, чтобы в пятне и дворе не было деревьев и
   камней, а ближайший житель был не ближе 6 клеток: между проверкой и
   применением команды проходит тик, и гуляющий не должен успеть зайти в
   пятно. */
function findBuildSpot(g, sim, owner) {
  const B = g.Buildings;
  const T = g.WorldGen.T;
  const world = sim.state.world;
  const town = g.Commands.townOf(sim.state, owner);
  if (!town || !town.townhall) throw new Error('у игрока ' + owner + ' нет ратуши');
  const center = B.center(town.townhall);
  const site = g.Commands.buildSiteOpts(sim.state);
  const solid = g.Villagers.blockedMap(world, sim.state.buildings);
  const fp = B.footprint(0, 'house');
  const probe = B.make({
    type: 'house', variant: 'a', rot: 0, x: 0, y: 0,
    owner: owner, town: town.id, id: 'probe'
  });
  const villagers = sim.state.villagers;
  const R = 45;
  let best = null, bestNear = -1;

  for (let y = 3; y < world.height - fp.h - 3; y++) {
    for (let x = 3; x < world.width - fp.w - 3; x++) {
      const dx = x + fp.w / 2 - center.x;
      const dy = y + fp.h / 2 - center.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > R * R) continue;
      /* Не ближе 12 клеток к своей ратуше: дом не должен попасть на кольцо,
         по которому стенд разводит дружины (3..6 клеток), и не должен менять
         подходы к чужой ратуше — подготовка боя считается до постройки. */
      if (d2 < 12 * 12) continue;
      let ok = true;
      for (let j = -1; j < fp.h + 1 && ok; j++) {
        for (let i = -1; i < fp.w + 1 && ok; i++) {
          const cx = x + i, cy = y + j;
          if (cx < 0 || cy < 0 || cx >= world.width || cy >= world.height) { ok = false; break; }
          if (world.tile[cy * world.width + cx] !== T.GRASS) { ok = false; break; }
          if (solid[cy * world.width + cx]) { ok = false; break; }
        }
      }
      if (!ok) continue;
      let near = Infinity;
      for (let k = 0; k < villagers.length; k++) {
        const v = villagers[k];
        if (!v || v.dead) continue;
        const d = Math.hypot(v.x - (x + fp.w / 2), v.y - (y + fp.h / 2));
        if (d < near) near = d;
        if (near <= bestNear) break;
      }
      if (near <= bestNear || near < 6) continue;
      probe.x = x; probe.y = y;
      const chk = B.canPlace(world, sim.state.buildings, probe, site);
      if (!chk.ok) continue;
      best = { x: x, y: y, near: near };
      bestNear = near;
    }
  }
  if (!best) throw new Error('не нашлось места под дом: игрок ' + owner);
  return best;
}

/* --------------------------------------------------------------- бой ----- */

/* Ставим дружины в 8–12 клетках от ратуши СЛЕДУЮЩЕГО игрока и отдаём приказ
   через Commands.apply. Место телепорта — проходимая клетка той же связной
   области, что и ратуша: иначе Army.order честно выкинет воина из приказа
   («другой берег»), и двадцать воинов будут стоять вдали от боя. */
function prepareCombat(g, sim, warriorsByOwner) {
  const B = g.Buildings;
  const V = g.Villagers;
  const world = sim.state.world;
  const solid = V.blockedMap(world, sim.state.buildings);
  const areas = V.areas(world, solid);
  const used = Object.create(null);
  const armies = [];

  function areaNear(cx, cy) {
    for (let r = 1; r <= 6; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = Math.round(cx + dx), y = Math.round(cy + dy);
          if (x < 0 || y < 0 || x >= world.width || y >= world.height) continue;
          if (!V.walkable(world, solid, x, y)) continue;
          return { x: x, y: y, id: areas.ids[y * world.width + x] };
        }
      }
    }
    return null;
  }

  /* Угрозы для выбора стороны подхода: всё, что принадлежит цели и может
     стать целью бойца РАНЬШЕ ратуши. Чем дальше от клетки такая угроза, тем
     спокойнее там начинать: боец не должен «залипнуть» на первом же чужом
     лагере у деревни. Ратуша в список не входит — к ней и идём. */
  function threatsOf(owner, townhall) {
    const out = [];
    for (let i = 0; i < sim.state.buildings.length; i++) {
      const b = sim.state.buildings[i];
      if (!b || b === townhall || b.rubble) continue;
      if ((b.owner === undefined ? 0 : b.owner) !== owner) continue;
      const fp = B.footprint(b.rot, b.type);
      out.push({ x: b.x + fp.w / 2, y: b.y + fp.h / 2, r: Math.hypot(fp.w, fp.h) / 2 });
    }
    for (let i = 0; i < sim.state.villagers.length; i++) {
      const v = sim.state.villagers[i];
      if (!v || v.dead) continue;
      if ((v.owner === undefined ? 0 : v.owner) !== owner) continue;
      out.push({ x: v.x, y: v.y, r: 0.5 });
    }
    return out;
  }

  /* Клетки круга 3..6 вокруг ратуши в ОДНОЙ связной области с ней. Из них
     берётся сектор с наибольшим зазором до чужих построек и жителей: дружина
     подходит с открытой стороны, а не из-за спины собственного лагеря цели. */
  function ringCells(cx, cy, areaId, count, threats) {
    const pool = [];
    for (let r = 3; r <= 6; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = Math.round(cx + dx), y = Math.round(cy + dy);
          if (x < 0 || y < 0 || x >= world.width || y >= world.height) continue;
          if (!V.walkable(world, solid, x, y)) continue;
          if (areas.ids[y * world.width + x] !== areaId) continue;
          const key = x + ',' + y;
          if (used[key]) continue;
          let score = Infinity;
          for (let i = 0; i < threats.length; i++) {
            const t = threats[i];
            const d = Math.hypot(x + 0.5 - t.x, y + 0.5 - t.y) - t.r;
            if (d < score) score = d;
          }
          pool.push({
            x: x, y: y, score: score,
            rad: Math.hypot(x + 0.5 - cx, y + 0.5 - cy),
            angle: Math.atan2(y + 0.5 - cy, x + 0.5 - cx)
          });
        }
      }
    }
    if (!pool.length) return [];
    function windowOf(center, half) {
      const out = [];
      for (let i = 0; i < pool.length; i++) {
        const p = pool[i];
        let da = Math.abs(((p.angle - center + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        if (da <= half) out.push(p);
      }
      return out;
    }
    let best = null;
    for (let i = 0; i < pool.length; i++) {
      const win = windowOf(pool[i].angle, 1.0);
      if (win.length < count) continue;
      let minScore = Infinity;
      for (let k = 0; k < win.length; k++) if (win[k].score < minScore) minScore = win[k].score;
      if (!best || minScore > best.minScore) best = { angle: pool[i].angle, minScore: minScore };
    }
    if (!best) best = { angle: pool[0].angle, minScore: -Infinity };
    let window = windowOf(best.angle, 1.0);
    if (window.length < count) window = windowOf(best.angle, 1.8);
    if (window.length < count) window = windowOf(best.angle, Math.PI);
    if (window.length < count) window = pool.slice();
    /* Сначала зазор до чужих построек, при равном — ближе к ратуше: бой
       должен начаться в первые секунды, а не после марша через полдеревни. */
    window.sort((a, b) => (b.score - a.score) || (a.rad - b.rad) || (a.y - b.y) || (a.x - b.x));
    const out = [];
    for (let i = 0; i < window.length && out.length < count; i++) {
      const key = window[i].x + ',' + window[i].y;
      if (used[key]) continue;
      used[key] = 1;
      out.push({ x: window[i].x + 0.5, y: window[i].y + 0.5 });
    }
    return out;
  }

  for (let owner = 0; owner < 3; owner++) {
    const targetOwner = (owner + 1) % 3;
    const targetTown = world.towns[targetOwner];
    const hall = targetTown.townhall;
    const center = B.center(hall);
    const area = areaNear(center.x, center.y);
    if (!area) throw new Error('ратуша игрока ' + targetOwner + ' отрезана от суши');
    const list = warriorsByOwner[owner];
    const threats = threatsOf(targetOwner, hall);
    const cells = ringCells(center.x, center.y, area.id, list.length, threats);
    if (cells.length < list.length) {
      throw new Error('мало клеток вокруг ратуши игрока ' + targetOwner +
        ': нужно ' + list.length + ', есть ' + cells.length);
    }
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      v.x = cells[i].x;
      v.y = cells[i].y;
      v.path = null;
      v.goal = null;
      v.target = null;
      v.combatMode = null;
      v.attackTarget = null;
      v.prevTarget = null;
      v.combatCell = null;
      v.combatCellFor = null;
      v.noPathKey = null;
      v.noPathT = 0;
      v.combatFail = 0;
      v.routeFail = 0;
      v.stuck = 0;
      v.order = null;
      v.state = 'patrol';
    }
    world._combatCells = null;
    armies.push({
      owner: owner, targetOwner: targetOwner,
      townhall: hall, center: center, warriors: list,
      hpBefore: hall.hp, maxHp: hall.maxHp,
      targetTownAliveBefore: targetTown.alive !== false,
      placed: cells.length
    });
  }
  g.Replication.reset();
  return armies;
}

function returnArmiesHome(g, sim, warriors) {
  const B = g.Buildings;
  const world = sim.state.world;
  const used = Object.create(null);
  for (let i = 0; i < warriors.length; i++) {
    const v = warriors[i];
    if (!v || v.dead || !v.warcamp) continue;
    const cells = B.patrolCells(v.warcamp);
    let spot = null;
    for (let k = 0; k < cells.length; k++) {
      const key = cells[k].x + ',' + cells[k].y;
      if (used[key]) continue;
      used[key] = 1;
      spot = cells[k];
      break;
    }
    if (spot) { v.x = spot.x + 0.5; v.y = spot.y + 0.5; }
    v.path = null;
    v.goal = null;
    v.target = null;
    v.combatMode = null;
    v.attackTarget = null;
    v.prevTarget = null;
    v.combatCell = null;
    v.combatCellFor = null;
    v.noPathKey = null;
    v.noPathT = 0;
    v.order = null;
    v.holdFire = false;
    v.state = 'patrol';
    v.anchor = { x: v.x, y: v.y };
  }
  world._combatCells = null;
}

/* --------------------------------------------------------------- отчёт --- */

function buildReport(ctx) {
  const m = ctx.m;
  const sim = ctx.sim;
  const world = ctx.world;
  const sec = Math.max(1e-9, m.observedSeconds);
  const ticks = m.ticks;
  const tickRate = ticks / sec;
  const snapRate = m.snaps / sec;
  const snapP95 = pct(m.snapIntervals, 0.95);
  const stepP99 = pct(m.stepMs, 0.99);
  const cpBytes = m.checkpointBytes.length ? Math.max.apply(null, m.checkpointBytes) : 0;
  const cpMs = m.checkpointMs.length ? Math.max.apply(null, m.checkpointMs) : 0;
  const quick = ctx.quick;

  const gates = [
    { name: 'ticksPerSecond', value: round2(tickRate), limit: quick ? 10 : 18, op: '>=', ok: tickRate >= (quick ? 10 : 18) },
    { name: 'snapshotsPerSecond', value: round2(snapRate), limit: quick ? 5 : 9, op: '>=', ok: snapRate >= (quick ? 5 : 9) },
    { name: 'snapshotIntervalP95Ms', value: snapP95, limit: quick ? 250 : 150, op: '<', ok: snapP95 !== null && snapP95 < (quick ? 250 : 150) },
    { name: 'stepP99Ms', value: stepP99, limit: quick ? 80 : 45, op: '<', ok: stepP99 !== null && stepP99 < (quick ? 80 : 45) },
    { name: 'checkpointBytes', value: cpBytes, limit: 30 * MB, op: '<', ok: cpBytes > 0 && cpBytes < 30 * MB },
    { name: 'checkpointCount', value: m.checkpointBytes.length, limit: 1, op: '>=', ok: m.checkpointBytes.length >= 1 },
    { name: 'roomFaults', value: ctx.faults.length, limit: 0, op: '==', ok: ctx.faults.length === 0 && !ctx.room.fault },
    { name: 'combatHits', value: ctx.combat.hitTicks, limit: 1, op: '>=', ok: ctx.combat.hitTicks >= 1 },
    { name: 'townhallDamage', value: ctx.combat.townhallDamage, limit: 1, op: '>=', ok: ctx.combat.townhallDamage >= 1 || ctx.combat.fallen >= 1 },
    { name: 'buildsApplied', value: ctx.builds.applied, limit: 1, op: '>=', ok: ctx.builds.applied >= 1 }
  ];
  const failed = gates.filter((x) => !x.ok);

  const activity = {
    villagers: sim.state.villagers.length,
    workersHired: sim.state.villagers.filter((v) => !!v.employer).length,
    chopping: sim.state.villagers.filter((v) => v.state === 'chop').length,
    carrying: sim.state.villagers.filter((v) => !!v.carrying).length,
    withPath: sim.state.villagers.filter((v) => v.path && v.path.length).length,
    stand: sim.state.villagers.filter((v) => v.state === 'stand').length,
    workersStand: sim.state.villagers.filter((v) => !!v.employer && v.state === 'stand').length,
    warriors: sim.state.villagers.filter((v) => !!v.warrior).length,
    warriorsAlive: sim.state.villagers.filter((v) => !!v.warrior && !v.dead).length,
    felled: world.towns.map((t) => t.felled || 0),
    logs: world.towns.map((t) => t.logs || 0),
    deliveries: world.towns.map((t) => t.deliveries || 0)
  };

  const report = {
    scenario: 'mp-midround',
    mode: ctx.mode,
    quick: quick,
    seed: SEED,
    environment: {
      cpus: os.cpus().length,
      loadavg: os.loadavg().map((x) => round2(x)),
      platform: process.platform,
      node: process.version
    },
    room: {
      id: ROOM_ID, size: 192, players: 3,
      statusAtEnd: ctx.statusAtEnd,
      worldOver: !!sim.state.over,
      winner: sim.state.winner,
      tick: ctx.room.tick, revision: ctx.room.revision,
      faults: ctx.faults.length,
      fault: ctx.room.fault || null,
      snapshotEveryTicks: ctx.room.snapshotEvery,
      checkpointEveryTicks: ctx.room.checkpointEvery
    },
    plan: {
      seconds: ctx.seconds,
      entitiesPerPlayer: ctx.perPlayer,
      warmupTicks: ctx.warmupTicks,
      buildIdsExpected: 3,
      armies: 3,
      warriorsPerArmy: ctx.staged.warriorsPer
    },
    staged: {
      placements: ctx.staged.placements,
      lumbercamps: ctx.staged.camps.map((a) => a.length),
      warcamps: ctx.staged.warcamps.map((a) => a.length),
      workers: ctx.staged.hired,
      civilians: ctx.staged.civilians.length,
      warriors: ctx.staged.warriors.length,
      startingVillagers: ctx.staged.startingVillagers,
      treesAdded: ctx.staged.treesAdded,
      campsWithTrees: ctx.staged.treeCounts.filter((n) => n > 0).length,
      campsWithFullTrees: ctx.staged.treeCounts.filter((n) => n >= ctx.staged.campTreesPer).length,
      objectsTotal: world.objectTotal,
      objectsLive: world.objects.length
    },
    observed: {
      seconds: round2(m.observedSeconds),
      plannedSeconds: ctx.seconds,
      ticks: ticks,
      simulatedSeconds: round2(ticks * 0.05),
      committedTickRate: round2(tickRate),
      snapshots: m.snaps,
      snapshotsPerSecond: round2(snapRate),
      snapshotsJsonBytes: m.snapBytes.length ? Math.max.apply(null, m.snapBytes) : 0,
      snapshotsGzipBytes: m.snapGzip.length ? Math.max.apply(null, m.snapGzip) : 0,
      snapshotSamples: m.snapBytes.length,
      checkpointCount: m.checkpointBytes.length,
      checkpointMaxBytes: cpBytes,
      checkpointMaxMb: bytesMb(cpBytes),
      checkpointMaxMs: round2(cpMs),
      stepMs: {
        p50: pct(m.stepMs, 0.5), p95: pct(m.stepMs, 0.95),
        p99: stepP99, max: maxOf(m.stepMs), samples: m.stepMs.length
      },
      snapshotIntervalMs: {
        p50: pct(m.snapIntervals, 0.5), p95: snapP95,
        p99: pct(m.snapIntervals, 0.99), max: maxOf(m.snapIntervals),
        samples: m.snapIntervals.length
      },
      navigation: {
        requests: m.nav.requests, ready: m.nav.ready,
        deferred: m.nav.deferred, unreachable: m.nav.unreachable,
        maxWaitTicks: m.nav.maxWaitTicks
      },
      memory: {
        rssMb: bytesMb(process.memoryUsage().rss),
        heapMb: bytesMb(process.memoryUsage().heapUsed),
        peakRssMb: bytesMb(m.peakRss),
        peakHeapMb: bytesMb(m.peakHeap)
      }
    },
    activity: activity,
    towns: world.towns.map((t) => ({
      id: t.id, owner: t.owner, alive: t.alive !== false,
      logs: t.logs || 0, felled: t.felled || 0, deliveries: t.deliveries || 0,
      townhall: t.townhall ? {
        id: t.townhall.id, hp: t.townhall.hp, maxHp: t.townhall.maxHp,
        rubble: !!t.townhall.rubble
      } : null
    })),
    combat: ctx.combat,
    builds: ctx.builds,
    commands: ctx.commands,
    gates: gates,
    gateNotes: (ctx.mode === 'fast'
      ? ['fast: rates measured on wall clock while ticks are not paced; step и snapshot — настоящие, ticks/s не про реальное время']
      : ['realtime: комната двигается своим pump по 50 мс на тик']).concat(
      os.loadavg()[0] > os.cpus().length / 2
        ? ['машина загружена (loadavg ' + round2(os.loadavg()[0]) + ' на ' +
           os.cpus().length + ' ядер): p99 шага измеряет ещё и борьбу за CPU']
        : []),
    result: failed.length ? 'MIDROUND FAIL' : 'MIDROUND PASS',
    failedGates: failed.map((x) => x.name)
  };
  return report;
}

/* --------------------------------------------------------------- main ---- */

async function main() {
  if (hasFlag('help')) {
    console.log('node game/tools/tests/mp-midround.js [--seconds N] [--entities N] [--realtime|--fast] [--quick]');
    return 0;
  }
  const g = loadEngine();
  const quick = hasFlag('quick');
  const mode = hasFlag('fast') ? 'fast' : 'realtime';
  const seconds = Math.max(3, Math.round(argNum('seconds', quick ? 12 : 30)));
  const perPlayer = Math.round(Math.min(320, Math.max(30, argNum('entities', quick ? 60 : 200))));
  const warmupTicks = Math.max(10, Math.min(80, Math.round(quick ? 20 : 40)));

  const staged = stageWorld(g, perPlayer);
  const sim = staged.sim;
  const world = staged.world;

  const warriorsByOwner = [[], [], []];
  for (let i = 0; i < staged.warriors.length; i++) {
    warriorsByOwner[staged.warriors[i].owner].push(staged.warriors[i]);
  }

  const faults = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '4tox-midround-'));
  const m = {
    measuring: false, ticks: 0, snaps: 0, observedSeconds: 0,
    stepMs: [], snapIntervals: [], snapBytes: [], snapGzip: [],
    checkpointBytes: [], checkpointMs: [],
    nav: { requests: 0, ready: 0, deferred: 0, unreachable: 0, maxWaitTicks: 0 },
    peakRss: 0, peakHeap: 0, lastSnapWall: 0, lastSampleWall: 0,
    lastSampleTick: 0
  };

  const fastClock = {
    now: () => Date.now(),
    setTimeout: () => 0,
    setImmediate: () => 0,
    clearTimeout: () => {}
  };

  const runtime = new RoomRuntime({
    roomId: ROOM_ID,
    seed: SEED,
    size: 192,
    players: [
      { sessionId: 's0', playerId: 1, owner: 0, name: 'A' },
      { sessionId: 's1', playerId: 2, owner: 1, name: 'B' },
      { sessionId: 's2', playerId: 3, owner: 2, name: 'C' }
    ],
    dir: dir,
    snapshotEveryTicks: 2,
    checkpointEveryTicks: 200,
    clock: mode === 'fast' ? fastClock : undefined,
    onSnapshot: function () {
      if (!m.measuring) return;
      const t = nowMs();
      if (m.lastSnapWall) m.snapIntervals.push(t - m.lastSnapWall);
      m.lastSnapWall = t;
      m.snaps++;
    },
    onFault: function (f) { faults.push(f); }
  });

  let closed = false;
  try {
    await runtime.start();
    stopPump(runtime);

    /* Мир комнаты заменяется целиком. Счётчики, очередь и baseline сбрасываются:
       иначе первый снимок нового мира пришёл бы с baseline от старого, а
       clientSequence игроков уже были бы израсходованы. */
    g.Replication.reset();
    runtime.sim = sim;
    runtime.tick = 0;
    runtime.revision = 0;
    runtime.latest = null;
    runtime.baselinePending = false;
    runtime.stats = freshRoomStats();
    runtime.queue = [];
    runtime.byId.clear();
    runtime.resultOrder = [];
    runtime.recentResults = [];
    runtime.debtMs = 0;
    runtime.checkpointBusy = false;
    runtime.checkpointPending = 0;
    runtime.checkpointPromise = null;
    runtime.lastPump = runtime.clock.now();
    for (let i = 0; i < runtime.players.length; i++) {
      const p = runtime.players[i];
      p.queue = [];
      p.nextClientSequence = 1;
      p.minRetainedSequence = 0;
      p.watermark = 0;
    }
    world.time = 0;
    runtime.status = 'running';

    /* Инструменты замера. Оборачиваем сам шаг комнаты: pump зовёт именно это
       свойство, поэтому и ручные тики, и настоящий pump попадают в одну мерку.
       Навигационные счётчики живут один тик (Navigation.beginTick их сбрасывает),
       поэтому складывать их нужно после каждого шага, а не в конце. */
    const origStep = runtime.executeAndCommitOneTick.bind(runtime);
    runtime.executeAndCommitOneTick = async function () {
      const t0 = nowMs();
      let out;
      try {
        out = await origStep();
      } catch (e) {
        if (m.measuring) m.stepMs.push(nowMs() - t0);
        throw e;
      }
      const dt = nowMs() - t0;
      if (m.measuring) {
        m.stepMs.push(dt);
        const ns = g.Navigation.diagnostics(world).stats;
        if (ns) {
          m.nav.requests += ns.requests || 0;
          m.nav.ready += ns.ready || 0;
          m.nav.deferred += ns.deferred || 0;
          m.nav.unreachable += ns.unreachable || 0;
          if ((ns.maxWaitTicks || 0) > m.nav.maxWaitTicks) m.nav.maxWaitTicks = ns.maxWaitTicks || 0;
        }
        if (ctx && ctx.combat && ctx.combat.active) sampleCombat();
      }
      return out;
    };

    const origWrite = runtime.writeCaptured.bind(runtime);
    runtime.writeCaptured = async function (cap) {
      const t0 = nowMs();
      let out;
      try {
        out = await origWrite(cap);
      } finally {
        if (m.measuring) m.checkpointMs.push(nowMs() - t0);
      }
      if (m.measuring && out && out.bytes) m.checkpointBytes.push(out.bytes);
      return out;
    };

    const ctx = {
      g: g, sim: sim, world: world, staged: staged, room: runtime,
      mode: mode, quick: quick, seconds: seconds, perPlayer: perPlayer,
      warmupTicks: warmupTicks, faults: faults, m: m,
      statusAtEnd: 'running',
      combat: {
        active: false, startedAtMs: null, endedAtMs: null,
        stopReason: null, hitTicks: 0, damageTotal: 0, townhallDamage: 0,
        townhallsDamaged: 0, townhallsFallen: 0, fallen: 0,
        armies: [], hpBefore: [], hpAfter: [],
        warriorsAliveBefore: 0, warriorsAliveAfter: 0,
        hitLog: []
      },
      builds: { expected: 3, submitted: 0, applied: 0, rejected: 0, ids: [], snapshotSeen: 0 },
      commands: []
    };

    /* Снимок боевого состояния: раз в тик сравниваем HP ратуш и воинов.
       Удар по ратуше — это и есть «combat hit»; отдельные удары Combat не
       журналирует, а HP меняет только ударом. */
    const tracked = [];
    function resetCombatTrackers() {
      tracked.length = 0;
      for (let i = 0; i < world.towns.length; i++) {
        const hall = world.towns[i].townhall;
        if (hall) tracked.push({ kind: 'hall', obj: hall, hp: hall.hp || 0 });
      }
      for (let i = 0; i < staged.warriors.length; i++) {
        const v = staged.warriors[i];
        tracked.push({ kind: 'warrior', obj: v, hp: v.hp || 0 });
      }
    }
    function sampleCombat() {
      let hit = 0, damage = 0, hallDamage = 0;
      for (let i = 0; i < tracked.length; i++) {
        const t = tracked[i];
        const obj = t.obj;
        const hp = obj.dead ? 0 : (obj.hp || 0);
        if (hp < t.hp) {
          hit++;
          damage += (t.hp - hp);
          if (t.kind === 'hall') hallDamage += (t.hp - hp);
          t.hp = hp;
        } else if (hp > t.hp) {
          t.hp = hp;
        }
      }
      if (hit > 0) {
        ctx.combat.hitTicks++;
        ctx.combat.damageTotal += damage;
        ctx.combat.townhallDamage += hallDamage;
      }
    }

    /* Прогрев: первый десяток тиков — это одновременный планировщик 360
       рабочих и первый обход карты. Он настоящий, но это не середина партии,
       а её старт; ворота меряют устойчивое окно. Прогрев явно назван в
       отчёте (warmupTicks), а не спрятан. */
    const warmStart = nowMs();
    if (mode === 'realtime') {
      runtime.schedulePump(1);
      while (runtime.tick < warmupTicks && runtime.status === 'running' &&
             nowMs() - warmStart < warmupTicks * 200 + 5000) {
        await sleep(20);
      }
    } else {
      for (let i = 0; i < warmupTicks; i++) {
        if (!(await runtime.executeAndCommitOneTick())) break;
      }
    }

    /* Сцена готовится ВНЕ измеряемого окна. Поиск места под дом (обход 200x200
       клеток и всех жителей) и развод дружин по кольцу чужой ратуши (полная
       карта связных областей) — работа стенда, а не комнаты. Внутри окна она
       останавливала бы главный поток на сотни миллисекунд, а потом измеритель
       видел бы догоняющие тики и честно засчитывал их в хвост шага. Сначала
       останавливаем pump: подготовка не должна идти вперемешку с тиком. */
    stopPump(runtime);
    await sleep(20);                     // догорел уже начатый тик, если был
    const buildSpots = [
      findBuildSpot(g, sim, 0), findBuildSpot(g, sim, 1), findBuildSpot(g, sim, 2)
    ];
    const armies = prepareCombat(g, sim, warriorsByOwner);
    ctx.combat.armies = armies.map((a) => ({
      owner: a.owner, targetOwner: a.targetOwner,
      townhallId: a.townhall.id, hpBefore: a.hpBefore, maxHp: a.maxHp,
      warriors: a.warriors.length, placed: a.placed
    }));
    ctx.combat.hpBefore = armies.map((a) => a.hpBefore);
    ctx.combat.warriorsAliveBefore = staged.warriors.filter((v) => !v.dead).length;

    /* Начало измеряемого окна. Всё, что было до него, в счёт не идёт. */
    m.measuring = true;
    m.stepMs.length = 0;
    m.snapIntervals.length = 0;
    m.snapBytes.length = 0;
    m.snapGzip.length = 0;
    m.checkpointBytes.length = 0;
    m.checkpointMs.length = 0;
    m.snaps = 0;
    m.lastSnapWall = 0;
    m.lastSampleWall = 0;
    m.lastSampleTick = runtime.tick;
    m.nav = { requests: 0, ready: 0, deferred: 0, unreachable: 0, maxWaitTicks: 0 };
    m.peakRss = 0;
    m.peakHeap = 0;
    runtime.stats = freshRoomStats();
    runtime.status = 'running';
    runtime.debtMs = 0;
    runtime.lastPump = runtime.clock.now();
    const startTick = runtime.tick;
    const startWall = nowMs();
    ctx.measureStartTick = startTick;
    if (mode === 'realtime') runtime.schedulePump(1);

    let endWall = startWall;

    /* --- команды постройки через runtime.submit --- */
    const buildIds = [];
    for (let owner = 0; owner < 3; owner++) {
      const spot = buildSpots[owner];
      const commandId = 's' + owner + '-mid:1';
      const receipt = await runtime.submit({
        protocol: 4, roomId: ROOM_ID, epoch: runtime.epoch,
        commandId: commandId, clientSequence: 1,
        type: 'build',
        payload: { buildingType: 'house', variant: 'a', rot: 0, x: spot.x, y: spot.y },
        sessionId: 's' + owner, playerId: owner + 1, owner: owner
      });
      ctx.builds.submitted++;
      if (!receipt || receipt.admitted !== true) {
        ctx.builds.rejected++;
        ctx.commands.push({
          channel: 'runtime', type: 'build', owner: owner, commandId: commandId,
          status: 'rejected', reasonCode: (receipt && receipt.reasonCode) || 'not_admitted',
          reason: '', ids: []
        });
      } else {
        buildIds.push(commandId);
        ctx.commands.push({
          channel: 'runtime', type: 'build', owner: owner, commandId: commandId,
          status: 'received', reasonCode: null, reason: '', ids: [], spot: spot
        });
      }
    }

    /* Ждём решения по трём командам: в realtime комната тикает сама, в fast
       тикаем руками. Предел ожидания — по СТЕНЕ в realtime и по тикам в fast,
       а не по числу итераций: иначе «3000 × 10 мс» растянули бы окно на
       полминуты, если команда почему-то не решилась. */
    const decideDeadline = nowMs() + 3000;
    let decideTicks = 0;
    while (buildIds.some((id) => {
      const r = runtime.byId.get(id);
      return !r || r.status === 'received' || r.status === 'unknown';
    })) {
      if (mode === 'fast') {
        if (++decideTicks > 80) break;
        if (!(await runtime.executeAndCommitOneTick())) break;
      } else {
        if (nowMs() > decideDeadline) break;
        await sleep(10);
      }
    }

    for (let i = 0; i < ctx.commands.length; i++) {
      const rec = ctx.commands[i];
      if (rec.channel !== 'runtime') continue;
      const res = runtime.byId.get(rec.commandId);
      if (!res) continue;
      rec.status = res.status;
      rec.reasonCode = res.reasonCode || null;
      rec.reason = res.reason || '';
      rec.ids = res.ids || [];
      rec.appliedTick = res.appliedTick;
      if (res.status === 'applied') {
        ctx.builds.applied++;
        for (let k = 0; k < (res.ids || []).length; k++) ctx.builds.ids.push(res.ids[k]);
      } else if (res.status === 'rejected' || res.status === 'expired') {
        ctx.builds.rejected++;
      }
    }

    /* Снимок должен УЖЕ содержать новый дом: команда applied мало что значит,
       если мир не доехал до клиента. Ждём до 2 с (это 20 снимков при 10/с). */
    const snapDeadline = nowMs() + 2000;
    let snapTicks = 0;
    while (ctx.builds.ids.some((id) => {
      const snap = runtime.latest;
      if (!snap || !snap.buildings) return true;
      for (let i = 0; i < snap.buildings.length; i++) if (snap.buildings[i].id === id) return false;
      return true;
    })) {
      if (mode === 'fast') {
        if (++snapTicks > 60) break;
        if (!(await runtime.executeAndCommitOneTick())) break;
      } else {
        if (nowMs() > snapDeadline) break;
        await sleep(10);
      }
    }
    if (runtime.latest && runtime.latest.buildings) {
      for (let i = 0; i < ctx.builds.ids.length; i++) {
        for (let k = 0; k < runtime.latest.buildings.length; k++) {
          if (runtime.latest.buildings[k].id === ctx.builds.ids[i]) { ctx.builds.snapshotSeen++; break; }
        }
      }
    }

    /* --- бой: дружины уже разведены, приказы идут через Commands.apply --- */
    resetCombatTrackers();
    ctx.combat.active = true;
    ctx.combat.startedAtMs = nowMs();
    for (let i = 0; i < armies.length; i++) {
      const a = armies[i];
      const ids = a.warriors.map((v) => v.id);
      const res = g.Commands.apply(sim.state, {
        type: 'order', owner: a.owner,
        payload: { ids: ids, x: a.center.x, y: a.center.y }
      });
      ctx.commands.push({
        channel: 'direct', type: 'order', owner: a.owner, commandId: null,
        status: res.status, reasonCode: res.reasonCode || null,
        reason: res.reason || '', ids: res.ids || ids
      });
      if (res.status !== 'applied') {
        throw new Error('приказ отряду не применён: игрок ' + a.owner + ', ' + (res.reason || res.reasonCode));
      }
      if ((res.ids || []).length !== ids.length) {
        throw new Error('в приказ попали не все воины: ' + (res.ids || []).length + '/' + ids.length);
      }
      /* Дружины вступают в бой не в один и тот же кадр: иначе две ратуши
         рассыпаются одновременно, и партия заканчивается прямо посреди
         окна замера. Полсекунды между приказами — это ещё и правдоподобно:
         три игрока не жмут кнопку синхронно. */
      if (i < armies.length - 1) {
        if (mode === 'realtime') await sleep(quick ? 250 : 500);
        else for (let st = 0; st < (quick ? 5 : 10); st++) await runtime.executeAndCommitOneTick();
      }
    }
    const combatDeadlineMs = Math.max(6000, seconds * 0.8 * 1000);
    const combatDeadlineTick = startTick + Math.round(seconds * 0.8 * 20);

    function fallenTowns() {
      let n = 0;
      for (let i = 0; i < world.towns.length; i++) {
        const t = world.towns[i];
        if (!t) continue;
        if (t.alive === false) n++;
        else if (t.townhall && (t.townhall.rubble || (t.townhall.hp || 0) <= 0)) n++;
      }
      return n;
    }

    function stopCombat(reason) {
      if (!ctx.combat.active) return;
      for (let owner = 0; owner < 3; owner++) {
        const res = g.Commands.apply(sim.state, {
          type: 'stop', owner: owner, payload: { ids: null }
        });
        ctx.commands.push({
          channel: 'direct', type: 'stop', owner: owner, commandId: null,
          status: res.status, reasonCode: res.reasonCode || null,
          reason: res.reason || '', ids: res.ids || []
        });
      }
      returnArmiesHome(g, sim, staged.warriors);
      ctx.combat.active = false;
      ctx.combat.endedAtMs = nowMs();
      ctx.combat.stopReason = reason;
    }

    function monitor() {
      const now = nowMs();
      if (!m.lastSampleWall || now - m.lastSampleWall >= 1000) {
        m.lastSampleWall = now;
        const mu = process.memoryUsage();
        if (mu.rss > m.peakRss) m.peakRss = mu.rss;
        if (mu.heapUsed > m.peakHeap) m.peakHeap = mu.heapUsed;
        const snap = runtime.latest;
        if (snap) {
          const text = JSON.stringify(snap);
          m.snapBytes.push(Buffer.byteLength(text, 'utf8'));
          m.snapGzip.push(zlib.gzipSync(text, { level: 1 }).length);
        }
      }
      if (ctx.combat.active) {
        const fallen = fallenTowns();
        if (fallen > 0) {
          stopCombat('town-fall');
        } else if (mode === 'realtime'
          ? (now - ctx.combat.startedAtMs > combatDeadlineMs)
          : (runtime.tick >= combatDeadlineTick)) {
          stopCombat('timeout');
        }
      }
    }

    /* --- измеряемое окно --- */
    if (mode === 'realtime') {
      runtime.schedulePump(1);
      const endAt = startWall + seconds * 1000;
      while (nowMs() < endAt && runtime.status === 'running') {
        await sleep(25);
        monitor();
      }
      endWall = nowMs();
    } else {
      const endTick = startTick + Math.round(seconds * 20);
      while (runtime.tick < endTick && runtime.status === 'running') {
        if (!(await runtime.executeAndCommitOneTick())) break;
        monitor();
      }
      endWall = nowMs();
    }

    /* Конец окна: числа фиксируются ДО остановки и закрытия, иначе в них
       попадут тики и снимки уборки. */
    ctx.statusAtEnd = runtime.status;
    const ticksAtEnd = runtime.stats.ticks;
    const snapsAtEnd = m.snaps;
    m.ticks = ticksAtEnd;
    m.snaps = snapsAtEnd;
    m.observedSeconds = Math.max(0.001, (endWall - startWall) / 1000);
    if (ctx.combat.active) stopCombat('window-end');

    m.measuring = false;
    stopPump(runtime);

    /* Дожидаемся уже начатого шага и checkpoint, чтобы файлы и счётчики успели
       закрыться. В окно это время не входит. */
    await sleep(60);
    try { await runtime.flushCheckpoint(); } catch (e) { /* fault уже записан */ }
    await sleep(30);
    try { await runtime.flushCheckpoint(); } catch (e) {}
    ctx.combat.endedAtMs = ctx.combat.endedAtMs || nowMs();

    /* Итоговое состояние боя и деревень. */
    ctx.combat.hpAfter = world.towns.map((t) => t.townhall ? t.townhall.hp : 0);
    ctx.combat.warriorsAliveAfter = staged.warriors.filter((v) => !v.dead && !v.hidden).length;
    ctx.combat.fallen = fallenTowns();
    ctx.combat.townhallsFallen = ctx.combat.fallen;
    for (let i = 0; i < armies.length; i++) {
      const a = armies[i];
      a.hpAfter = a.townhall.hp;
      a.fallen = a.townhall.rubble || (a.townhall.hp || 0) <= 0 ||
        (world.towns[a.targetOwner] && world.towns[a.targetOwner].alive === false);
      if ((a.hpBefore || 0) > (a.hpAfter || 0)) ctx.combat.townhallsDamaged++;
      a.damage = Math.max(0, (a.hpBefore || 0) - (a.hpAfter || 0));
      a.targetTownAliveAfter = world.towns[a.targetOwner] ?
        world.towns[a.targetOwner].alive !== false : false;
    }
    ctx.combat.armies = ctx.combat.armies.map((a, i) => Object.assign({}, a, {
      hpAfter: armies[i].hpAfter,
      damage: armies[i].damage,
      fallen: armies[i].fallen,
      targetTownAliveAfter: armies[i].targetTownAliveAfter
    }));
    ctx.combat.warriors = {
      total: staged.warriors.length,
      aliveBefore: ctx.combat.warriorsAliveBefore,
      aliveAfter: ctx.combat.warriorsAliveAfter,
      dead: staged.warriors.length - ctx.combat.warriorsAliveAfter
    };
    ctx.combat.durationMs = Math.round((ctx.combat.endedAtMs || 0) - (ctx.combat.startedAtMs || 0));
    ctx.combat.warriorsAlive = ctx.combat.warriorsAliveAfter;
    ctx.combat.townhallHpBefore = ctx.combat.hpBefore;
    ctx.combat.townhallHpAfter = ctx.combat.hpAfter;

    ctx.commands.forEach((c) => {
      if (!c.status) c.status = 'unknown';
    });
    const applied = ctx.commands.filter((c) => c.status === 'applied').length;
    const rejected = ctx.commands.filter((c) => c.status !== 'applied').length;
    ctx.commandSummary = { total: ctx.commands.length, applied: applied, rejected: rejected };

    const report = buildReport(ctx);
    report.commandSummary = ctx.commandSummary;

    fs.mkdirSync(OUT_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(OUT_DIR, 'mp-midround-' + stamp + '.json');
    report.reportFile = path.relative(ROOT, file);
    fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');

    await runtime.close('mp-midround');
    closed = true;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}

    console.log(JSON.stringify(report, null, 2));
    console.log('written ' + file);
    const failed = report.gates.filter((x) => !x.ok);
    if (failed.length) {
      console.log('MIDROUND FAIL');
      for (let i = 0; i < failed.length; i++) {
        console.log('  gate ' + failed[i].name + ' = ' + failed[i].value +
          ' (нужно ' + failed[i].op + ' ' + failed[i].limit + ')');
      }
      return 1;
    }
    console.log('MIDROUND PASS');
    return 0;
  } finally {
    if (!closed) {
      try { await runtime.close('mp-midround-error'); } catch (e) {}
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    }
  }
}

main().then(function (code) {
  process.exit(code);
}).catch(function (e) {
  console.error(e && e.stack ? e.stack : e);
  console.error('MIDROUND FAIL (exception)');
  process.exit(1);
});
