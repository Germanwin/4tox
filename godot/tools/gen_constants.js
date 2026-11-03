/* gen_constants.js — числа игры из JS в `godot/data/constants.json`.
 *
 * Зачем. Цены, вместимости, время тренировки, зум и пороги мыши — правила
 * браузерной игры. Если переписать их руками в GDScript, клиент и эталон
 * разъедутся на первой же правке баланса. Скрипт читает те же файлы, что
 * грузит браузер, и складывает числа в JSON; GDScript их только читает.
 *
 * Запуск: node godot/tools/gen_constants.js
 * Приёмка: node godot/tests/test_constants.js (сверяет JSON с JS заново).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'godot', 'data', 'constants.json');

/* Движок — те же IIFE, что в браузере. Грузим ровно те файлы, которым не
   нужен DOM: Buildings/Combat/Session/Render-числа живут в них. */
function loadEngineHere() {
  const mod = require(path.join(ROOT, 'game', 'tools', 'tests', 'load-engine.js'));
  return mod.loadEngine();
}

function readPlay() {
  return fs.readFileSync(path.join(ROOT, 'game', 'js', 'play.js'), 'utf8');
}

/* Пороги заданы не только числами: PAN_SLOP = CLICK_SLOP, PLACE_SLOP =
   HOLD_SLOP. Поэтому берём ВЫРАЖЕНИЕ из исходника и считаем его в песочнице
   с уже прочитанными числами — так значение остаётся тем же, что в игре. */
function num(source, name, known) {
  const m = source.match(new RegExp('var ' + name + '\\s*=\\s*([^;]+);'));
  if (!m) throw new Error('не найдено число ' + name + ' в play.js');
  const expr = m[1].trim();
  const ctx = Object.assign({ Math: Math }, known || {});
  const value = vm.runInNewContext('(' + expr + ')', ctx);
  if (typeof value !== 'number' || !isFinite(value)) {
    throw new Error('не число: ' + name + ' = ' + expr);
  }
  return value;
}

function buildMenu(source) {
  const m = source.match(/var BUILD_MENU = (\[[\s\S]*?\n  \]);/);
  if (!m) throw new Error('не найден BUILD_MENU в play.js');
  return vm.runInNewContext('(' + m[1] + ')');
}

function build() {
  const E = loadEngineHere();
  const B = E.Buildings;
  const C = E.Combat;
  const S = E.Session;
  const play = readPlay();

  const slots = {};
  const training = {};
  for (const type of B.TYPE_IDS) {
    slots[type] = B.workSlots({ type: type, level: 1 });
    training[type] = B.trainingSlots({ type: type, level: 1 });
  }

  const combat = C && C.CONFIG ? C.CONFIG : {};
  /* Длительность прохода анимации. Двоичный кадр 4TX1 несёт только phase на
     момент снимка, поэтому клиент двигает фазу сам — по этим числам. */
  const G = E.GameplayConfig;
  const anim = {};
  if (G && G.profiles) {
    for (const profile of ['villager', 'warrior']) {
      anim[profile] = {};
      const prof = G.profiles[profile] || {};
      for (const name of Object.keys(prof)) {
        const a = prof[name];
        anim[profile][name] = { frames: a.frames, fps: a.fps, loop: !!a.loop,
          duration: a.frames / a.fps };
      }
    }
  }
  const known = {};
  known.CLICK_SLOP = num(play, 'CLICK_SLOP');
  known.HOLD_SLOP = num(play, 'HOLD_SLOP');
  known.PAN_SLOP = num(play, 'PAN_SLOP', known);
  known.PLACE_SLOP = num(play, 'PLACE_SLOP', known);

  return {
    generatedAt: new Date().toISOString(),
    source: [
      'mapgen2/js/buildings.js', 'mapgen2/js/combat.js', 'mapgen2/js/session.js',
      'game/js/play.js'
    ],
    zoom: { min: 3, max: 120 },
    input: {
      clickSlop: known.CLICK_SLOP,
      holdSlop: known.HOLD_SLOP,
      panSlop: known.PAN_SLOP,
      placeSlop: known.PLACE_SLOP,
      holdMs: num(play, 'EDIT_HOLD_MS'),
      doubleMs: num(play, 'EDIT_HOLD_MS'),
      arrivalSeconds: num(play, 'ARRIVAL')
    },
    buildMenu: buildMenu(play),
    caps: {
      warcamp: B.WARCAMP_CAP,
      barracksYard: B.BARRACKS_YARD_CAP,
      yard: B.YARD,
      faceRot: B.FACE_ROT,
      lineMax: B.LINE_MAX,
      lineGap: B.LINE_GAP
    },
    slots: { work: slots, training: training },
    trainTime: S.TRAIN_TIME,
    housing: {
      houseLevel: B.HOUSE_LEVEL,
      housingCapacity: B.housingCapacity({ type: 'house', level: 1 })
    },
    combat: {
      hp: combat.hp || null,
      damage: combat.damage || null,
      interval: combat.interval || null,
      windup: combat.windup,
      range: combat.range,
      aggro: combat.aggro,
      defendR: combat.defendR,
      retargetR: combat.retargetR,
      barTime: combat.barTime,
      flinch: combat.flinch
    },
    anim: anim,
    names: {
      townhall: 'Ратуша', house: 'Дом жителя', lumbercamp: 'Лагерь лесоруба',
      barracks: 'Казарма', warcamp: 'Военный лагерь'
    }
  };
}

function main() {
  const data = build();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(data, null, 2) + '\n');
  console.log('constants → ' + path.relative(ROOT, OUT));
  console.log('  цены: ' + data.buildMenu.map(function (b) {
    return b.type + ' ' + b.price;
  }).join(', '));
  console.log('  вместимости: лагерь ' + data.caps.warcamp + ', двор ' +
    data.caps.barracksYard + ', тренировка ' + data.trainTime + ' с');
}

if (require.main === module) main();
module.exports = { build: build, OUT: OUT };
