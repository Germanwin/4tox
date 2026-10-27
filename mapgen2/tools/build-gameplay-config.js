#!/usr/bin/env node
/* build-gameplay-config.js — собрать mapgen2/js/simulation/gameplay-config.js
   из РЕАЛЬНЫХ источников проекта.

   Зачем это отдельный инструмент. Чистому движку (mapgen2/js/simulation/),
   который будет крутиться в Node без браузера, нельзя передавать renderer,
   Image, Canvas или DOM. Но правила мира не должны быть выдуманы: число
   кадров, fps и loop живут в атласах, цены — в меню построек игры, времена
   обучения — в Session. Поэтому данные не копируются в тесты руками, а
   извлекаются здесь и складываются в маленький сгенерированный модуль.

   Что читается:
     mapgen2/assets/villager/atlas.json
     mapgen2/assets/armored_villager/atlas.json
     mapgen2/js/villager.js   (константы скорости, рубки, таймингов)
     mapgen2/js/session.js    (обучение/растворение/появление/рождение)
     mapgen2/js/buildings.js  (YARD, вместимости, TRAIN)
     game/js/play.js          (BUILD_MENU и BUILD_SITE)

   PNG не читается ни при каких условиях: нужны метаданные кадров, а не
   пиксели. Если atlas.json в checkout нет, но есть atlas.js, берётся его
   фактический экспорт в ОТДЕЛЬНОМ Node-контексте (vm): ни document, ни
   Image, ни Canvas туда не подкладываются; единственная переменная, которую
   даёт контекст, — `window`, потому что atlas.js пишет экспорт именно в неё.

   Сгенерированный файл детерминирован: ключи объектов стоят в стабильном
   порядке, в конце перевода строки. `hash` — sha256 канонической (с
   отсортированными ключами) записи логических данных; `sourceHashes` —
   sha256 самих исходников атласов. Поэтому правка атласа или исходных
   констант видна и без пересборки.

   Запуск:
     node mapgen2/tools/build-gameplay-config.js          # пересобрать файл
     node mapgen2/tools/build-gameplay-config.js --check  # только проверить

   --check ничего не пишет и возвращает:
     0 — файл совпадает с источниками;
     1 — файл устарел/испорчен (печатается diff-сообщение);
     2 — источник не читается или изменил форму (печатается причина).

   Для проверки ВРЕМЕННОЙ копии (не трогая боевой файл):
     node mapgen2/tools/build-gameplay-config.js --check --config /tmp/x.js
*/
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const CONFIG_PATH = path.join(ROOT, 'mapgen2', 'js', 'simulation', 'gameplay-config.js');
const CONFIG_REL = 'mapgen2/js/simulation/gameplay-config.js';
/* Версия ФОРМЫ конфига (не данных). Поднимать при несовместимом
   переименовании полей, чтобы --check старого файла падал явно. */
const CONFIG_VERSION = 1;

const ATLAS_SOURCES = {
  villager: {
    dir: 'mapgen2/assets/villager',
    json: 'atlas.json',
    js: 'atlas.js',
    meta: 'VILLAGER_ATLAS'
  },
  warrior: {
    dir: 'mapgen2/assets/armored_villager',
    json: 'atlas.json',
    js: 'atlas.js',
    meta: 'ARMORED_VILLAGER_ATLAS'
  }
};

const SOURCE_FILES = {
  villager: 'mapgen2/js/villager.js',
  session: 'mapgen2/js/session.js',
  buildings: 'mapgen2/js/buildings.js',
  play: 'game/js/play.js'
};

const PROFILE_KEYS = ['villager', 'warrior'];

/* ------------------------------------------------------------------ утилиты */

function relPath(abs) {
  const rel = path.relative(ROOT, abs);
  return rel.split(path.sep).join('/');
}

function readText(rel) {
  const abs = path.join(ROOT, rel);
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch (err) {
    throw new Error('не читается ' + rel + ': ' + err.message);
  }
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/* Объект с отсортированными ключами: один и тот же результат при любом
   порядке исходных записей. Массивы остаются массивами. */
function sortObj(obj) {
  const out = {};
  for (const key of Object.keys(obj).sort()) out[key] = obj[key];
  return out;
}

/* Каноническая запись данных для hash. Это НЕ то же самое, что красивый
   JSON в файле: здесь ключи сортируются рекурсивно, поэтому hash не зависит
   от порядка полей в коде сборщика. */
function stableStringify(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('в конфиг попало не-число: ' + value);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((key) =>
      JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
  }
  throw new TypeError('stableStringify: неподдерживаемое значение ' + typeof value);
}

/* ------------------------------------------------------- константы из текста */

/* Найти ровно одну строку `var NAME = <expr>;` и вернуть expr.
   Дубликат имени — ошибка, а не «взяли первую»: иначе правка ниже по файлу
   молча не замечалась бы. */
function readConstExpression(text, name, file) {
  const re = new RegExp('(?:^|\\n)[ \\t]*var[ \\t]+' + name + '[ \\t]*=[ \\t]*([^;\\n]+);', 'g');
  const matches = Array.from(text.matchAll(re));
  if (matches.length !== 1) {
    throw new Error(file + ': ожидалось одно объявление `var ' + name +
      ' = ...;`, найдено ' + matches.length);
  }
  return matches[0][1].trim();
}

/* Посчитать числовое выражение константы. Разрешены только числа, знаки
   арифметики и уже разобранные имена этого же файла. Никаких функций и
   обращений к окружению: это данные, а не исполняемый код. */
function evalConst(expr, values, name, file) {
  const substituted = expr.replace(/(?<![0-9.])[A-Za-z_][A-Za-z0-9_]*/g, (id) => {
    if (!Object.prototype.hasOwnProperty.call(values, id)) {
      throw new Error(file + ': ' + name + ' ссылается на неизвестную константу ' +
        id + ' в выражении `' + expr + '`');
    }
    return '(' + values[id] + ')';
  });
  if (!/^[0-9eE+\-*/().\s]+$/.test(substituted)) {
    throw new Error(file + ': ' + name + ' — не числовое выражение: `' + expr + '`');
  }
  let value;
  try {
    value = Function('"use strict"; return (' + substituted + ');')();
  } catch (err) {
    throw new Error(file + ': не удалось посчитать ' + name + ' = `' + expr + '`: ' + err.message);
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(file + ': ' + name + ' = `' + expr + '` даёт не конечное число');
  }
  return value;
}

/* Разобрать список констант по порядку: более поздние могут ссылаться на
   более ранние (так задан SPEED = SPEED_STEP * SPEED_BOOST / SHRINK). */
function readNumbers(text, names, file) {
  const values = {};
  for (const name of names) {
    const expr = readConstExpression(text, name, file);
    values[name] = evalConst(expr, values, name, file);
  }
  return values;
}

/* ANIM_FALLBACK — таблица логических имён анимаций, которую использует
   animResolve в villager.js. Она задана литералом; берём её из источника,
   чтобы сгенерированный конфиг не разошёлся с движком. */
function readAnimFallback(text) {
  const match = text.match(/var\s+ANIM_FALLBACK\s*=\s*(\{[\s\S]*?\n  \});/);
  if (!match) throw new Error(SOURCE_FILES.villager + ': не найдена таблица ANIM_FALLBACK');
  let table;
  try {
    table = Function('"use strict"; return (' + match[1] + ');')();
  } catch (err) {
    throw new Error(SOURCE_FILES.villager + ': ANIM_FALLBACK не разбирается: ' + err.message);
  }
  if (!table || typeof table !== 'object' || Array.isArray(table)) {
    throw new Error(SOURCE_FILES.villager + ': ANIM_FALLBACK — не объект');
  }
  for (const key of Object.keys(table)) {
    const chain = table[key];
    if (!Array.isArray(chain) || !chain.length ||
        chain.some((name) => typeof name !== 'string' || !name)) {
      throw new Error(SOURCE_FILES.villager + ': ANIM_FALLBACK["' + key +
        '"] должен быть непустым массивом имён');
    }
  }
  return table;
}

/* TRAIN — таблица тренировочных мест. Нужно только число мест казармы
   первого уровня: логика спрашивает его у Buildings.trainingSlots. */
function readTrainSlots(text) {
  const match = text.match(/var\s+TRAIN\s*=\s*(\{[\s\S]*?\n  \});/);
  if (!match) throw new Error(SOURCE_FILES.buildings + ': не найдена таблица TRAIN');
  let table;
  try {
    table = Function('"use strict"; return (' + match[1] + ');')();
  } catch (err) {
    throw new Error(SOURCE_FILES.buildings + ': TRAIN не разбирается: ' + err.message);
  }
  if (!table || typeof table !== 'object') {
    throw new Error(SOURCE_FILES.buildings + ': TRAIN — не объект');
  }
  const barracks = table.barracks;
  const slots = barracks && (barracks[1] !== undefined ? barracks[1] : barracks['1']);
  if (!Number.isInteger(slots) || slots < 0) {
    throw new Error(SOURCE_FILES.buildings + ': TRAIN.barracks[1] должно быть целым >= 0');
  }
  return slots;
}

/* BUILD_MENU — цены построек. Цена это правило игры, поэтому она обязана
   совпадать с play.js, а не жить второй копией в этом файле. */
function readPrices(text) {
  const start = text.indexOf('var BUILD_MENU = [');
  if (start < 0) throw new Error(SOURCE_FILES.play + ': не найден BUILD_MENU');
  const end = text.indexOf('\n  ];', start);
  if (end < 0) throw new Error(SOURCE_FILES.play + ': не найден конец BUILD_MENU');
  /* Комментарии внутри массива не должны попадать в подсчёт записей:
     иначе слово `type:` в пояснении ломало бы разбор. */
  const block = text.slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  const typeCount = (block.match(/type\s*:\s*['"]/g) || []).length;
  const prices = {};
  const re = /type\s*:\s*['"]([^'"]+)['"][^}]*?price\s*:\s*([0-9]+)/g;
  let match;
  while ((match = re.exec(block)) !== null) {
    const type = match[1];
    const price = Number(match[2]);
    if (!/^[a-z][a-z0-9_]*$/.test(type)) {
      throw new Error(SOURCE_FILES.play + ': странный тип постройки в BUILD_MENU: ' + type);
    }
    if (Object.prototype.hasOwnProperty.call(prices, type)) {
      throw new Error(SOURCE_FILES.play + ': тип ' + type + ' повторяется в BUILD_MENU');
    }
    if (!Number.isInteger(price) || price <= 0) {
      throw new Error(SOURCE_FILES.play + ': цена ' + type + ' должна быть целой > 0');
    }
    prices[type] = price;
  }
  if (Object.keys(prices).length !== typeCount || !Object.keys(prices).length) {
    throw new Error(SOURCE_FILES.play + ': BUILD_MENU разобран не полностью (' +
      Object.keys(prices).length + ' из ' + typeCount + ')');
  }
  return prices;
}

/* BUILD_SITE в play.js: clearable:false, requireClear:true, yard:Buildings.YARD.
   Если эти правила изменят, сборка должна остановиться, а не тихо выдать
   конфиг с другим смыслом. */
function readBuildSite(text, yard) {
  const re = /var\s+BUILD_SITE\s*=\s*\{\s*clearable\s*:\s*(true|false)\s*,\s*requireClear\s*:\s*(true|false)\s*,\s*yard\s*:\s*global\.Buildings\.YARD\s*\};/;
  const match = text.match(re);
  if (!match) {
    throw new Error(SOURCE_FILES.play + ': BUILD_SITE не найден в ожидаемой форме ' +
      '{ clearable, requireClear, yard: global.Buildings.YARD }');
  }
  const clearable = match[1] === 'true';
  const requireClear = match[2] === 'true';
  if (clearable !== false || requireClear !== true) {
    throw new Error(SOURCE_FILES.play + ': BUILD_SITE изменил смысл (' +
      'clearable=' + clearable + ', requireClear=' + requireClear + '); ' +
      'обновите конфиг и приёмку осознанно');
  }
  if (!(yard > 0)) throw new Error('Buildings.YARD должно быть > 0');
  return { clearable: clearable, requireClear: requireClear, yard: yard };
}

/* ------------------------------------------------------------------- атласы */

/* atlas.js пишет export в window. В отдельном vm-контексте единственная
   подстановка — window, указывающая на сам контекст: это не DOM-заглушка, а
   адрес экспорта, который выбрал файл. Ни document, ни Image, ни Canvas,
   ни fetch здесь нет. */
function loadAtlasScript(jsPath, metaName) {
  const code = fs.readFileSync(jsPath, 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext('var window = globalThis;', sandbox, {
    filename: 'atlas-export-target.js'
  });
  vm.runInContext(code, sandbox, { filename: jsPath, timeout: 5000 });
  const data = sandbox[metaName] || (sandbox.window && sandbox.window[metaName]);
  if (!data) {
    throw new Error(relPath(jsPath) + ': экспорт ' + metaName + ' не найден');
  }
  return data;
}

/* Вернуть атлас из JSON, а если JSON нет — из atlas.js. PNG не читается. */
function loadAtlas(profile, spec) {
  const dirAbs = path.join(ROOT, spec.dir);
  const jsonAbs = path.join(dirAbs, spec.json);
  if (fs.existsSync(jsonAbs)) {
    const bytes = fs.readFileSync(jsonAbs);
    let data;
    try {
      data = JSON.parse(bytes.toString('utf8'));
    } catch (err) {
      throw new Error(relPath(jsonAbs) + ': JSON не разбирается: ' + err.message);
    }
    return {
      profile: profile,
      data: data,
      sha256: sha256(bytes),
      file: relPath(jsonAbs),
      format: 'json'
    };
  }
  const jsAbs = path.join(dirAbs, spec.js);
  if (!fs.existsSync(jsAbs)) {
    throw new Error('нет ни ' + relPath(jsonAbs) + ', ни ' + relPath(jsAbs));
  }
  const bytes = fs.readFileSync(jsAbs);
  return {
    profile: profile,
    data: loadAtlasScript(jsAbs, spec.meta),
    sha256: sha256(bytes),
    file: relPath(jsAbs),
    format: 'js'
  };
}

/* Достать из атласа только логические метаданные кадров: frames/fps/loop.
   Ни x/y, ни anchor, ни пиксели сюда не попадают. */
function readAnimations(atlas, file) {
  if (!atlas || typeof atlas !== 'object' || Array.isArray(atlas)) {
    throw new Error(file + ': атлас — не объект');
  }
  const anims = atlas.anims;
  if (!anims || typeof anims !== 'object' || Array.isArray(anims) ||
      !Object.keys(anims).length) {
    throw new Error(file + ': нет непустого объекта anims');
  }
  const out = {};
  for (const name of Object.keys(anims).sort()) {
    const a = anims[name];
    if (!a || typeof a !== 'object' || Array.isArray(a)) {
      throw new Error(file + ': anims.' + name + ' — не объект');
    }
    const frames = Number(a.frames);
    const fps = Number(a.fps);
    if (!Number.isInteger(frames) || frames <= 0) {
      throw new Error(file + ': anims.' + name + '.frames должно быть целым > 0');
    }
    if (!Number.isFinite(fps) || fps <= 0) {
      throw new Error(file + ': anims.' + name + '.fps должно быть конечным > 0');
    }
    if (typeof a.loop !== 'boolean') {
      throw new Error(file + ': anims.' + name + '.loop должно быть boolean');
    }
    out[name] = { frames: frames, fps: fps, loop: a.loop };
  }
  return out;
}

/* Разрешение логических имён так, как это делает animResolve в villager.js:
   идём по цепочке ANIM_FALLBACK, берём первый кадр, который реально есть в
   атласе, иначе idle. Результат замораживается в конфиге: чистой логике не
   нужно знать ни Hero, ни загружен ли PNG. */
function resolveLogical(animations, fallback) {
  const names = new Set(Object.keys(fallback).concat(Object.keys(animations)));
  const out = {};
  for (const want of Array.from(names).sort()) {
    const chain = Array.isArray(fallback[want]) ? fallback[want] : [want];
    let resolved = null;
    for (const candidate of chain) {
      if (Object.prototype.hasOwnProperty.call(animations, candidate)) {
        resolved = candidate;
        break;
      }
    }
    if (resolved === null) {
      if (!Object.prototype.hasOwnProperty.call(animations, 'idle')) {
        throw new Error('в атласе нет idle: логическое имя ' + want + ' некуда разрешить');
      }
      resolved = 'idle';
    }
    out[want] = resolved;
  }
  return out;
}

/* -------------------------------------------------------------------- сборка */

function build() {
  /* 1. Атласы: настоящие метаданные, sha256 исходных файлов. */
  const atlases = {};
  for (const profile of PROFILE_KEYS) {
    atlases[profile] = loadAtlas(profile, ATLAS_SOURCES[profile]);
  }

  /* 2. Константы из движка и игры. */
  const villagerText = readText(SOURCE_FILES.villager);
  const sessionText = readText(SOURCE_FILES.session);
  const buildingsText = readText(SOURCE_FILES.buildings);
  const playText = readText(SOURCE_FILES.play);

  const villagerNumbers = readNumbers(villagerText, [
    'SHRINK', 'SPEED_STEP', 'SPEED_BOOST', 'SPEED', 'ARRIVE', 'APPEAR_TIME',
    'CHOP_TIME', 'CHOP_HIT', 'CHOP_HITS', 'CHOP_HIT_EVERY',
    'LOGS_PER_TRIP', 'TAKE_TIME', 'WANDER_R', 'WANDER_RETRY', 'STAND_OFF'
  ], SOURCE_FILES.villager);

  const sessionNumbers = readNumbers(sessionText, [
    'VILLAGERS', 'TRAIN_TIME', 'VANISH_TIME', 'EMERGE_TIME',
    'BIRTH_EVERY', 'BIRTH_FADE', 'BIRTH_RETRY',
    'WORK_STAND_TIME', 'WORK_EVENT_GAP'
  ], SOURCE_FILES.session);

  const buildingNumbers = readNumbers(buildingsText, [
    'YARD', 'WARCAMP_CAP', 'BARRACKS_YARD_CAP', 'LINE_MAX', 'LINE_GAP'
  ], SOURCE_FILES.buildings);

  const fallback = readAnimFallback(villagerText);
  const trainSlots = readTrainSlots(buildingsText);
  const prices = sortObj(readPrices(playText));
  const buildSite = sortObj(readBuildSite(playText, buildingNumbers.YARD));

  /* 3. Профили: физические кадры атласа, по объекту {frames,fps,loop} на
     имя. Рядом — logical: разрешение логических имён (animResolve), чтобы
     чистая логика не зависела от HTMLImageElement и загрузки PNG. */
  const profiles = {};
  const logical = {};
  for (const profile of PROFILE_KEYS) {
    const animations = readAnimations(atlases[profile].data, atlases[profile].file);
    profiles[profile] = animations;
    logical[profile] = sortObj(resolveLogical(animations, fallback));
  }

  /* 4. dropDuration выводится из carry_put, а не задаётся числом. Если
     кадра сдачи нет, это ошибка: подставлять 1/3 «по памяти» запрещено. */
  const carryPut = profiles.villager.carry_put;
  if (!carryPut) {
    throw new Error('в профиле villager нет carry_put: dropDuration вывести не из чего ' +
      '(подставлять 1/3 без метаданных нельзя)');
  }
  const dropDuration = carryPut.frames / carryPut.fps;
  if (!Number.isFinite(dropDuration) || dropDuration <= 0) {
    throw new Error('carry_put даёт неположительный dropDuration');
  }
  const drop = sortObj({
    animation: 'carry_put',
    fps: carryPut.fps,
    frames: carryPut.frames,
    loop: carryPut.loop,
    profile: 'villager'
  });

  /* 5. Логические длительности действий. Это те числа, которые нужны
     чистой логике: рубить, брать топор, сдавать, учить, растворяться,
     появляться, рожать, простаивать. Источник у каждого — константа выше. */
  const actions = sortObj({
    appear: villagerNumbers.APPEAR_TIME,
    birthEvery: sessionNumbers.BIRTH_EVERY,
    birthFade: sessionNumbers.BIRTH_FADE,
    birthRetry: sessionNumbers.BIRTH_RETRY,
    chop: villagerNumbers.CHOP_TIME,
    chopHitEvery: villagerNumbers.CHOP_HIT_EVERY,
    chopHitPhase: villagerNumbers.CHOP_HIT,
    chopHits: villagerNumbers.CHOP_HITS,
    drop: dropDuration,
    emerge: sessionNumbers.EMERGE_TIME,
    take: villagerNumbers.TAKE_TIME,
    train: sessionNumbers.TRAIN_TIME,
    vanish: sessionNumbers.VANISH_TIME,
    workEventGap: sessionNumbers.WORK_EVENT_GAP,
    workStand: sessionNumbers.WORK_STAND_TIME
  });

  const constants = sortObj({
    APPEAR_TIME: villagerNumbers.APPEAR_TIME,
    ARRIVE: villagerNumbers.ARRIVE,
    BIRTH_EVERY: sessionNumbers.BIRTH_EVERY,
    BIRTH_FADE: sessionNumbers.BIRTH_FADE,
    BIRTH_RETRY: sessionNumbers.BIRTH_RETRY,
    CHOP_HIT: villagerNumbers.CHOP_HIT,
    CHOP_HITS: villagerNumbers.CHOP_HITS,
    CHOP_HIT_EVERY: villagerNumbers.CHOP_HIT_EVERY,
    CHOP_TIME: villagerNumbers.CHOP_TIME,
    EMERGE_TIME: sessionNumbers.EMERGE_TIME,
    LOGS_PER_TRIP: villagerNumbers.LOGS_PER_TRIP,
    SHRINK: villagerNumbers.SHRINK,
    SPEED: villagerNumbers.SPEED,
    SPEED_BOOST: villagerNumbers.SPEED_BOOST,
    SPEED_STEP: villagerNumbers.SPEED_STEP,
    STAND_OFF: villagerNumbers.STAND_OFF,
    TAKE_TIME: villagerNumbers.TAKE_TIME,
    TRAIN_TIME: sessionNumbers.TRAIN_TIME,
    VANISH_TIME: sessionNumbers.VANISH_TIME,
    VILLAGERS: sessionNumbers.VILLAGERS,
    WANDER_R: villagerNumbers.WANDER_R,
    WANDER_RETRY: villagerNumbers.WANDER_RETRY,
    WORK_EVENT_GAP: sessionNumbers.WORK_EVENT_GAP,
    WORK_STAND_TIME: sessionNumbers.WORK_STAND_TIME
  });

  const buildings = sortObj({
    BARRACKS_YARD_CAP: buildingNumbers.BARRACKS_YARD_CAP,
    LINE_GAP: buildingNumbers.LINE_GAP,
    LINE_MAX: buildingNumbers.LINE_MAX,
    TRAIN_SLOTS: { barracks: trainSlots },
    WARCAMP_CAP: buildingNumbers.WARCAMP_CAP,
    YARD: buildingNumbers.YARD
  });

  const sourceHashes = sortObj({
    villager: atlases.villager.sha256,
    warrior: atlases.warrior.sha256
  });

  /* 6. hash — только логические данные. sourceHashes живут рядом, но в hash
     не входят: он отвечает на вопрос «изменились ли правила/кадры», а
     sourceHashes — «изменился ли исходник». */
  const logicalData = {
    configVersion: CONFIG_VERSION,
    dropDuration: dropDuration,
    drop: drop,
    profiles: profiles,
    logical: logical,
    actions: actions,
    prices: prices,
    buildSite: buildSite,
    buildings: buildings,
    constants: constants
  };
  const hash = sha256(Buffer.from(stableStringify(logicalData), 'utf8'));

  const config = {
    configVersion: CONFIG_VERSION,
    sourceHashes: sourceHashes,
    hash: hash,
    dropDuration: dropDuration,
    drop: drop,
    profiles: profiles,
    logical: logical,
    actions: actions,
    prices: prices,
    buildSite: buildSite,
    buildings: buildings,
    constants: constants
  };

  return {
    config: config,
    text: render(config, { atlases: atlases }),
    hash: hash,
    sourceHashes: sourceHashes,
    dropDuration: dropDuration,
    atlases: atlases
  };
}

/* ---------------------------------------------------------------- генерация */

const CONFIG_HEADER = [
  '/* gameplay-config.js — СГЕНЕРИРОВАННЫЙ файл игровых данных.',
  '',
  '   НЕ ПРАВИТЬ РУКАМИ. Источник правды:',
  '     mapgen2/assets/villager/atlas.json (или atlas.js, если JSON нет)',
  '     mapgen2/assets/armored_villager/atlas.json (или atlas.js, если JSON нет)',
  '     mapgen2/js/villager.js, mapgen2/js/session.js,',
  '     mapgen2/js/buildings.js, game/js/play.js',
  '',
  '   Пересобрать: node mapgen2/tools/build-gameplay-config.js',
  '   Проверить:   node mapgen2/tools/build-gameplay-config.js --check',
  '',
  '   PNG здесь не читается: только метаданные кадров. dropDuration выведен',
  '   из carry_put (frames / fps), а не задан числом. profiles — физические',
  '   кадры атласа ({frames,fps,loop} на имя), logical — разрешение логических',
  '   имён так, как его делает animResolve. UI и сервер должны читать этот конфиг.'
];

function render(config, meta) {
  const json = JSON.stringify(config, null, 2);
  const indented = json.split('\n').map((line, i) => i === 0 ? line : '  ' + line).join('\n');
  const lines = [];
  for (const line of CONFIG_HEADER) lines.push(line);
  lines.push('');
  lines.push('   Источники кадров (sha256 исходного файла):');
  for (const profile of PROFILE_KEYS) {
    const src = meta.atlases[profile];
    lines.push('     ' + profile + ': ' + src.file + '  ' + src.format + '  sha256 ' + src.sha256);
  }
  lines.push('   hash логических данных: ' + config.hash);
  lines.push('   dropDuration: ' + config.drop.frames + ' кадра / ' + config.drop.fps +
    ' fps = ' + config.dropDuration + ' с');
  lines.push('*/');
  lines.push('(function (global) {');
  lines.push("  'use strict';");
  lines.push('');
  lines.push('  var CONFIG = ' + indented + ';');
  lines.push('');
  lines.push('  /*');
  lines.push('     Логическая анимация профиля. Возвращает то, что нужно чистой');
  lines.push('     логике: имя реально нарисованного кадра, frames, fps, loop и');
  lines.push('     длительность одного прохода. Разрешение имён уже посчитано при');
  lines.push('     сборке по ANIM_FALLBACK и реальным кадрам атласа; неизвестное');
  lines.push('     имя, как и animResolve, уходит в idle.');
  lines.push('  */');
  lines.push('  function animation(profileName, want) {');
  lines.push('    var profile = Object.prototype.hasOwnProperty.call(CONFIG.profiles, profileName)');
  lines.push('      ? CONFIG.profiles[profileName] : null;');
  lines.push("    if (!profile) throw new Error('GameplayConfig: нет профиля \"' + profileName + '\"');");
  lines.push("    if (typeof want !== 'string' || !want) throw new TypeError('GameplayConfig: имя анимации должно быть непустой строкой');");
  lines.push('    var names = Object.prototype.hasOwnProperty.call(CONFIG.logical, profileName)');
  lines.push('      ? CONFIG.logical[profileName] : {};');
  lines.push('    var name = Object.prototype.hasOwnProperty.call(names, want) ? names[want] : null;');
  lines.push('    if (!name) name = Object.prototype.hasOwnProperty.call(profile, want) ? want : \'idle\';');
  lines.push('    var anim = Object.prototype.hasOwnProperty.call(profile, name) ? profile[name] : null;');
  lines.push("    if (!anim) throw new Error('GameplayConfig: в профиле \"' + profileName + '\" нет кадра \"' + name + '\"');");
  lines.push('    return {');
  lines.push('      profile: profileName,');
  lines.push('      requested: want,');
  lines.push('      name: name,');
  lines.push('      frames: anim.frames,');
  lines.push('      fps: anim.fps,');
  lines.push('      loop: anim.loop,');
  lines.push('      duration: anim.frames / anim.fps');
  lines.push('    };');
  lines.push('  }');
  lines.push('');
  lines.push('  /*');
  lines.push('     Опции Buildings.canPlace для покупки/постановки. Смысл BUILD_SITE');
  lines.push('     (clearable:false, requireClear:true, yard) сохраняется, но сюда же');
  lines.push('     попадают ЖИВЫЕ жители партии: серверная проверка обязана звать');
  lines.push('     этот helper со своим списком, иначе дом встанет в человека.');
  lines.push('  */');
  lines.push('  function buildSiteOpts(villagers) {');
  lines.push('    return {');
  lines.push('      clearable: CONFIG.buildSite.clearable,');
  lines.push('      requireClear: CONFIG.buildSite.requireClear,');
  lines.push('      yard: CONFIG.buildSite.yard,');
  lines.push('      villagers: Array.isArray(villagers) ? villagers : []');
  lines.push('    };');
  lines.push('  }');
  lines.push('');
  lines.push('  /*');
  lines.push('     Удобные имена для старых/параллельных потребителей. Они не');
  lines.push('     перечисляются и поэтому не попадают ни в JSON, ни в hash:');
  lines.push('     animations — кадры жителя по умолчанию (profiles.villager),');
  lines.push('     buildPrices — синоним prices для команд сервера.');
  lines.push('     У каждого профиля тоже есть невидимый animations, указывающий');
  lines.push('     на него самого: код, писавший profiles.villager.animations,');
  lines.push('     продолжает работать, а данные остаются плоскими.');
  lines.push('  */');
  lines.push('  var profileNames = Object.keys(CONFIG.profiles);');
  lines.push('  for (var pi = 0; pi < profileNames.length; pi++) {');
  lines.push('    var prof = CONFIG.profiles[profileNames[pi]];');
  lines.push("    Object.defineProperty(prof, 'animations', { value: prof, enumerable: false });");
  lines.push('  }');
  lines.push("  Object.defineProperty(CONFIG, 'animations', { value: CONFIG.profiles.villager, enumerable: false });");
  lines.push("  Object.defineProperty(CONFIG, 'buildPrices', { value: CONFIG.prices, enumerable: false });");
  lines.push('');
  lines.push('  /* Методы не перечисляются в JSON: CONFIG остаётся чистыми данными. */');
  lines.push("  Object.defineProperty(CONFIG, 'animation', { value: animation, enumerable: false });");
  lines.push("  Object.defineProperty(CONFIG, 'buildSiteOpts', { value: buildSiteOpts, enumerable: false });");
  lines.push('');
  lines.push('  global.GameplayConfig = CONFIG;');
  lines.push("  if (typeof module !== 'undefined' && module.exports) module.exports = CONFIG;");
  lines.push("})(typeof window !== 'undefined' ? window : globalThis);");
  return lines.join('\n') + '\n';
}

/* ---------------------------------------------------------------- проверка */

function parseSourceHashes(text) {
  const block = text.match(/"sourceHashes"\s*:\s*\{([\s\S]*?)\}/);
  if (!block) return null;
  const out = {};
  for (const profile of PROFILE_KEYS) {
    const m = block[1].match(new RegExp('"' + profile + '"\\s*:\\s*"([0-9a-f]{64})"'));
    if (m) out[profile] = m[1];
  }
  return out;
}

function parseLogicalHash(text) {
  const m = text.match(/\n\s+"hash"\s*:\s*"([0-9a-f]{64})"/);
  return m ? m[1] : null;
}

/* Разобрать JSON-литерал CONFIG из сгенерированного файла, НЕ исполняя код:
   это важно для --check, который обязан пережить испорченный файл. */
function parseCommittedConfig(text) {
  const m = text.match(/\n  var CONFIG = (\{[\s\S]*?\n  \});/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch (err) {
    return null;
  }
}

/* Пересчитать hash по данным уже записанного файла. Если он не совпал с
   полем hash, файл правили руками: текст разошёлся сам с собой. */
function logicalHashOfConfig(config) {
  const copy = JSON.parse(JSON.stringify(config));
  delete copy.sourceHashes;
  delete copy.hash;
  return sha256(Buffer.from(stableStringify(copy), 'utf8'));
}

function firstDifference(actual, expected) {
  const a = actual.split('\n');
  const b = expected.split('\n');
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (i === a.length && i === b.length) return null;
  return {
    line: i + 1,
    committed: i < a.length ? a[i] : '<конец файла>',
    generated: i < b.length ? b[i] : '<конец файла>'
  };
}

function countDifferentLines(actual, expected) {
  const a = actual.split('\n');
  const b = expected.split('\n');
  const max = Math.max(a.length, b.length);
  let n = 0;
  for (let i = 0; i < max; i++) if (a[i] !== b[i]) n++;
  return n;
}

function normalizeConfigPath(p) {
  if (!p) return CONFIG_PATH;
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

/* Пересобрать в памяти и сравнить с файлом. Ничего не пишет. */
function check(options) {
  const configPath = normalizeConfigPath(options && options.configPath);
  const built = build();
  let actual = null;
  try {
    actual = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    return {
      ok: false,
      configPath: configPath,
      expectedText: built.text,
      actualText: null,
      current: { hash: built.hash, sourceHashes: built.sourceHashes },
      committed: { hash: null, sourceHashes: null, internalHash: null },
      firstDifference: null,
      messages: ['не читается проверяемый файл: ' + (err.code || err.message)]
    };
  }
  if (actual === built.text) {
    return {
      ok: true,
      configPath: configPath,
      expectedText: built.text,
      actualText: actual,
      current: { hash: built.hash, sourceHashes: built.sourceHashes },
      committed: {
        hash: built.hash,
        sourceHashes: built.sourceHashes,
        internalHash: built.hash
      },
      firstDifference: null,
      messages: []
    };
  }

  const committedHashes = parseSourceHashes(actual);
  const committedHash = parseLogicalHash(actual);
  const committedConfig = parseCommittedConfig(actual);
  const internalHash = committedConfig ? logicalHashOfConfig(committedConfig) : null;
  const messages = [];
  for (const profile of PROFILE_KEYS) {
    const committed = committedHashes && committedHashes[profile];
    const current = built.sourceHashes[profile];
    if (committed !== current) {
      messages.push('source hash mismatch (' + profile + '): committed ' +
        (committed || '<нет>') + ', current ' + current);
    }
  }
  if (committedConfig && committedHash && internalHash !== committedHash) {
    messages.push('committed file is internally inconsistent: field hash ' +
      committedHash + ', but its data hashes to ' + internalHash);
  }
  if (committedHash !== built.hash) {
    messages.push('logical hash mismatch: committed ' + (committedHash || '<нет>') +
      ', current ' + built.hash);
  }
  const diff = firstDifference(actual, built.text);
  const changed = countDifferentLines(actual, built.text);
  if (diff) {
    messages.push('text differs: ' + changed + ' строк(и), первое расхождение в строке ' + diff.line);
  } else {
    messages.push('text differs');
  }
  return {
    ok: false,
    configPath: configPath,
    expectedText: built.text,
    actualText: actual,
    current: { hash: built.hash, sourceHashes: built.sourceHashes },
    committed: {
      hash: committedHash,
      sourceHashes: committedHashes,
      internalHash: internalHash
    },
    firstDifference: diff,
    messages: messages
  };
}

/* ------------------------------------------------------------------- CLI */

function displayPath(abs) {
  const rel = path.relative(ROOT, abs);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    return rel.split(path.sep).join('/');
  }
  return abs;
}

function formatCheckFailure(result) {
  const out = [];
  out.push('gameplay-config: OUT OF DATE');
  out.push('  file: ' + displayPath(result.configPath));
  for (const message of result.messages) out.push('  ' + message);
  if (result.firstDifference) {
    const d = result.firstDifference;
    out.push('  первое расхождение, строка ' + d.line + ':');
    out.push('    - ' + d.committed);
    out.push('    + ' + d.generated);
  }
  out.push('  пересобрать: node mapgen2/tools/build-gameplay-config.js');
  return out.join('\n');
}

function parseArgs(argv) {
  const opts = { check: false, configPath: CONFIG_PATH, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') {
      opts.check = true;
    } else if (arg === '--config') {
      const value = argv[++i];
      if (!value) throw new Error('--config требует путь к файлу');
      opts.configPath = normalizeConfigPath(value);
    } else if (arg.startsWith('--config=')) {
      const value = arg.slice('--config='.length);
      if (!value) throw new Error('--config требует путь к файлу');
      opts.configPath = normalizeConfigPath(value);
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else {
      throw new Error('неизвестный аргумент: ' + arg);
    }
  }
  if (opts.check === false && opts.configPath !== CONFIG_PATH) {
    throw new Error('--config имеет смысл только вместе с --check');
  }
  return opts;
}

function usage() {
  return [
    'usage: node mapgen2/tools/build-gameplay-config.js [--check] [--config <path>]',
    '',
    '  без --check  пересобрать ' + CONFIG_REL,
    '  --check      ничего не писать; 0 — совпадает, 1 — устарел, 2 — ошибка',
    '  --config     проверять другую копию (только с --check)',
    '  --help       эта справка'
  ].join('\n');
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error('gameplay-config: ' + err.message);
    console.error(usage());
    return 2;
  }
  if (opts.help) {
    console.log(usage());
    return 0;
  }
  try {
    if (opts.check) {
      const result = check({ configPath: opts.configPath });
      if (result.ok) {
        console.log('gameplay-config: up to date');
        console.log('  file: ' + displayPath(result.configPath));
        console.log('  hash: ' + result.current.hash);
        return 0;
      }
      console.error(formatCheckFailure(result));
      return 1;
    }

    const built = build();
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, built.text, 'utf8');
    console.log('gameplay-config: wrote ' + CONFIG_REL);
    console.log('  hash: ' + built.hash);
    console.log('  sourceHashes.villager: ' + built.sourceHashes.villager);
    console.log('  sourceHashes.warrior: ' + built.sourceHashes.warrior);
    console.log('  dropDuration: ' + built.dropDuration);
    return 0;
  } catch (err) {
    console.error('gameplay-config: ' + err.message);
    return 2;
  }
}

module.exports = {
  build: build,
  check: check,
  render: render,
  loadAtlasScript: loadAtlasScript,
  stableStringify: stableStringify,
  sha256: sha256,
  CONFIG_PATH: CONFIG_PATH,
  CONFIG_REL: CONFIG_REL,
  CONFIG_VERSION: CONFIG_VERSION,
  SOURCE_FILES: SOURCE_FILES,
  ATLAS_SOURCES: ATLAS_SOURCES
};

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
