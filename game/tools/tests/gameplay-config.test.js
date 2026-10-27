/* gameplay-config.test.js — приёмка сгенерированных игровых данных.

   Что проверяется:
     * mapgen2/js/simulation/gameplay-config.js грузится и в Node (CommonJS),
       и в браузерном стиле (IIFE пишет globalThis.GameplayConfig), и оба
       объекта несут одни и те же данные;
     * все логические имена анимаций обоих профилей разрешаются в реальный
       кадр атласа с конечными frames/fps и boolean loop;
     * dropDuration выведен из carry_put (4 кадра / 12 fps), а не объявлен
       числом 1/3;
     * цены совпадают с BUILD_MENU в game/js/play.js, а BUILD_SITE сохраняет
       clearable:false / requireClear:true / yard:Buildings.YARD и умеет
       добавлять живых жителей;
     * hash/sourceHashes — настоящие sha256 источников и логических данных;
     * `node mapgen2/tools/build-gameplay-config.js --check` на боевом файле
       возвращает 0 и ничего не пишет, а на испорченной временной копии —
       возвращает 1 с diff-сообщением.

   Запуск: node --test game/tools/tests/gameplay-config.test.js */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const CONFIG_PATH = path.join(ROOT, 'mapgen2', 'js', 'simulation', 'gameplay-config.js');
const BUILD_TOOL = path.join(ROOT, 'mapgen2', 'tools', 'build-gameplay-config.js');
const VILLAGER_ATLAS = path.join(ROOT, 'mapgen2', 'assets', 'villager', 'atlas.json');
const WARRIOR_ATLAS = path.join(ROOT, 'mapgen2', 'assets', 'armored_villager', 'atlas.json');
const VILLAGER_JS = path.join(ROOT, 'mapgen2', 'js', 'villager.js');
const SESSION_JS = path.join(ROOT, 'mapgen2', 'js', 'session.js');
const BUILDINGS_JS = path.join(ROOT, 'mapgen2', 'js', 'buildings.js');
const PLAY_JS = path.join(ROOT, 'game', 'js', 'play.js');

const ATLAS_PATHS = {
  villager: VILLAGER_ATLAS,
  warrior: WARRIOR_ATLAS
};

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/* Независимая от сборщика каноническая запись: если у build-скрипта и теста
   одинаковый баг в стабильном JSON, hash бы сошёлся, а проверка была бы
   пустой. Поэтому алгоритм здесь записан заново. */
function canonical(value) {
  if (value === null || typeof value === 'string' ||
      typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonical).join(',') + ']';
  }
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) =>
      JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  throw new TypeError('canonical: unsupported ' + typeof value);
}

/* Свежий require: проверяем именно файл на диске, а не кэш Node. */
function loadNodeConfig() {
  delete require.cache[require.resolve(CONFIG_PATH)];
  return require(CONFIG_PATH);
}

/* Браузерный стиль без CommonJS: отдельный vm-контекст, window === globalThis,
   никаких document/Image/Canvas. */
function loadBrowserConfig() {
  const code = fs.readFileSync(CONFIG_PATH, 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext('window = globalThis;', sandbox, { filename: 'browser-style.js' });
  vm.runInContext(code, sandbox, { filename: 'gameplay-config.js' });
  return sandbox.GameplayConfig;
}

function parseNumberConst(text, name) {
  const re = new RegExp('var\\s+' + name + '\\s*=\\s*([0-9]+(?:\\.[0-9]+)?)\\s*;');
  const match = text.match(re);
  assert.ok(match, 'не найдена числовая константа ' + name);
  return Number(match[1]);
}

/* Независимый от сборщика разбор BUILD_MENU: цена — правило игры, её нельзя
   сверять с самой собой через BUILD_MENU из сгенерированного файла. */
function parseBuildMenu(text) {
  const start = text.indexOf('var BUILD_MENU = [');
  assert.ok(start >= 0, 'BUILD_MENU не найден');
  const end = text.indexOf('];', start);
  assert.ok(end > start, 'конец BUILD_MENU не найден');
  const block = text.slice(start, end);
  const prices = {};
  const re = /type:\s*'([^']+)'[^}]*?price:\s*([0-9]+)/g;
  let match;
  while ((match = re.exec(block)) !== null) prices[match[1]] = Number(match[2]);
  return prices;
}

function runCheck(args) {
  return spawnSync(process.execPath, [BUILD_TOOL, '--check'].concat(args || []), {
    cwd: ROOT,
    encoding: 'utf8'
  });
}

test('Node: файл грузится, CommonJS export и globalThis.GameplayConfig', () => {
  const cfg = loadNodeConfig();
  assert.ok(cfg && typeof cfg === 'object');
  assert.equal(globalThis.GameplayConfig, cfg);
  assert.equal(cfg.configVersion, 1);
  assert.equal(typeof cfg.animation, 'function');
  assert.equal(typeof cfg.buildSiteOpts, 'function');
  assert.equal(cfg.animations, cfg.profiles.villager);
  assert.equal(cfg.profiles.villager.animations, cfg.profiles.villager);
  assert.equal(cfg.buildPrices, cfg.prices);
  assert.equal(cfg.dropDuration > 0, true);
});

test('браузерный стиль: IIFE без module пишет globalThis.GameplayConfig', () => {
  const nodeCfg = loadNodeConfig();
  const browserCfg = loadBrowserConfig();
  assert.ok(browserCfg && typeof browserCfg === 'object');
  assert.equal(typeof browserCfg.animation, 'function');
  assert.equal(typeof browserCfg.buildSiteOpts, 'function');
  /* Через JSON: объекты из vm-контекста имеют другой прототип, и
     deepStrictEqual по сырым объектам ругался бы на realm, а не на данные. */
  assert.deepEqual(
    JSON.parse(JSON.stringify(browserCfg)),
    JSON.parse(JSON.stringify(nodeCfg))
  );
  assert.equal(browserCfg.animation('villager', 'carry_put').name, 'carry_put');
  assert.equal(browserCfg.animation('warrior', 'carry_put').name, 'idle');
  assert.equal(browserCfg.animations, browserCfg.profiles.villager);
  assert.equal(browserCfg.buildPrices, browserCfg.prices);
});

test('atlas.js fallback: фактический экспорт в отдельном vm-контексте', () => {
  const builder = require(BUILD_TOOL);
  const cases = [
    [VILLAGER_ATLAS.replace(/\.json$/, '.js'), 'VILLAGER_ATLAS', VILLAGER_ATLAS],
    [WARRIOR_ATLAS.replace(/\.json$/, '.js'), 'ARMORED_VILLAGER_ATLAS', WARRIOR_ATLAS]
  ];
  for (const [jsPath, metaName, jsonPath] of cases) {
    assert.equal(fs.existsSync(jsPath), true, 'нет ' + jsPath);
    const fromScript = builder.loadAtlasScript(jsPath, metaName);
    assert.ok(fromScript && fromScript.anims, 'atlas.js не отдал anims: ' + jsPath);
    const fromJson = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    assert.deepEqual(
      JSON.parse(JSON.stringify(fromScript.anims)),
      fromJson.anims,
      'atlas.js и atlas.json должны описывать одни кадры'
    );
  }
});

test('оба профиля: все логические анимации имеют finite frames/fps/loop', () => {
  const cfg = loadNodeConfig();
  assert.deepEqual(Object.keys(cfg.profiles), ['villager', 'warrior']);

  const expectedAnimations = {
    villager: ['carry', 'carry_put', 'idle', 'walk', 'walk_axe', 'work'],
    warrior: ['idle', 'walk', 'work']
  };

  for (const profileName of ['villager', 'warrior']) {
    const profile = cfg.profiles[profileName];
    assert.ok(profile, 'нет профиля ' + profileName);
    assert.deepEqual(Object.keys(profile), expectedAnimations[profileName],
      'набор физических кадров ' + profileName);

    for (const animName of Object.keys(profile)) {
      const anim = profile[animName];
      assert.equal(typeof anim.frames, 'number', profileName + '.' + animName + '.frames');
      assert.equal(Number.isInteger(anim.frames) && anim.frames > 0, true,
        profileName + '.' + animName + '.frames должно быть целым > 0');
      assert.equal(Number.isFinite(anim.fps) && anim.fps > 0, true,
        profileName + '.' + animName + '.fps должно быть конечным > 0');
      assert.equal(typeof anim.loop, 'boolean',
        profileName + '.' + animName + '.loop должно быть boolean');
    }

    assert.ok(Object.keys(cfg.logical[profileName]).length > 0,
      'у профиля ' + profileName + ' нет разрешения логических имён');

    for (const logicalName of Object.keys(cfg.logical[profileName])) {
      const resolved = cfg.animation(profileName, logicalName);
      assert.equal(resolved.profile, profileName);
      assert.equal(resolved.requested, logicalName);
      assert.equal(resolved.name, cfg.logical[profileName][logicalName],
        'разрешение ' + profileName + '.' + logicalName);
      assert.ok(Object.prototype.hasOwnProperty.call(profile, resolved.name),
        'разрешённый кадр ' + profileName + '.' + logicalName + ' отсутствует');
      assert.equal(Number.isFinite(resolved.frames) && resolved.frames > 0, true);
      assert.equal(Number.isFinite(resolved.fps) && resolved.fps > 0, true);
      assert.equal(typeof resolved.loop, 'boolean');
      assert.equal(resolved.duration, resolved.frames / resolved.fps);
    }
  }

  const cfgVillager = cfg.logical.villager;
  const cfgWarrior = cfg.logical.warrior;
  assert.equal(cfgVillager.carry_put, 'carry_put');
  assert.equal(cfgVillager.toTree, 'walk_axe');
  assert.equal(cfgWarrior.carry_put, 'idle');
  assert.equal(cfgWarrior.toTree, 'walk');
  assert.equal(cfg.animation('warrior', 'walk_axe').name, 'idle');
  assert.equal(cfg.animation('villager', 'unknown-state').name, 'idle');
  assert.throws(() => cfg.animation('nobody', 'idle'), /профиля/);
  assert.throws(() => cfg.animation('villager', ''), /непустой строкой/);
});

test('dropDuration выведен из carry_put: 4 кадра / 12 fps = 1/3', () => {
  const cfg = loadNodeConfig();
  const atlas = JSON.parse(fs.readFileSync(VILLAGER_ATLAS, 'utf8'));
  const carryPut = atlas.anims.carry_put;

  assert.ok(carryPut, 'в атласе жителя нет carry_put');
  assert.equal(carryPut.frames, 4);
  assert.equal(carryPut.fps, 12);
  assert.equal(carryPut.loop, false);

  assert.equal(cfg.dropDuration, carryPut.frames / carryPut.fps,
    'dropDuration должен быть frames/fps из метаданных');
  assert.equal(cfg.dropDuration, 1 / 3);
  assert.deepEqual(cfg.drop, {
    animation: 'carry_put',
    fps: 12,
    frames: 4,
    loop: false,
    profile: 'villager'
  });
  assert.equal(cfg.actions.drop, cfg.dropDuration);
  assert.equal(cfg.profiles.villager.carry_put.frames, carryPut.frames);
  assert.equal(cfg.profiles.villager.carry_put.fps, carryPut.fps);
});

test('sourceHashes — sha256 атласов, hash — sha256 логических данных', () => {
  const cfg = loadNodeConfig();
  for (const profileName of ['villager', 'warrior']) {
    const expected = sha256(fs.readFileSync(ATLAS_PATHS[profileName]));
    assert.equal(cfg.sourceHashes[profileName], expected,
      'sourceHashes.' + profileName);
    assert.match(cfg.sourceHashes[profileName], /^[0-9a-f]{64}$/);
  }

  const logical = JSON.parse(JSON.stringify(cfg));
  delete logical.sourceHashes;
  delete logical.hash;
  assert.equal(cfg.hash, sha256(Buffer.from(canonical(logical), 'utf8')),
    'hash должен быть sha256 канонической записи логических данных');
  assert.match(cfg.hash, /^[0-9a-f]{64}$/);
});

test('цены совпадают с BUILD_MENU play.js, BUILD_SITE сохраняет смысл', () => {
  const cfg = loadNodeConfig();
  const playText = fs.readFileSync(PLAY_JS, 'utf8');
  const menuPrices = parseBuildMenu(playText);

  assert.deepEqual(cfg.prices, menuPrices);
  assert.deepEqual(cfg.prices, {
    barracks: 28,
    house: 12,
    lumbercamp: 20,
    warcamp: 24
  });

  const buildingsText = fs.readFileSync(BUILDINGS_JS, 'utf8');
  const yard = parseNumberConst(buildingsText, 'YARD');
  assert.deepEqual(cfg.buildSite, {
    clearable: false,
    requireClear: true,
    yard: yard
  });
  assert.equal(cfg.buildings.YARD, yard);
  assert.equal(cfg.buildings.WARCAMP_CAP, parseNumberConst(buildingsText, 'WARCAMP_CAP'));
  assert.equal(cfg.buildings.BARRACKS_YARD_CAP, parseNumberConst(buildingsText, 'BARRACKS_YARD_CAP'));
  assert.equal(cfg.buildings.LINE_MAX, parseNumberConst(buildingsText, 'LINE_MAX'));
  assert.equal(cfg.buildings.LINE_GAP, parseNumberConst(buildingsText, 'LINE_GAP'));
  assert.equal(cfg.buildings.TRAIN_SLOTS.barracks, 3);

  const villagers = [{ id: 7, x: 1, y: 2 }];
  assert.deepEqual(cfg.buildSiteOpts(villagers), {
    clearable: false,
    requireClear: true,
    yard: yard,
    villagers: villagers
  });
  assert.equal(cfg.buildSiteOpts(villagers).villagers, villagers,
    'живые жители должны попадать в проверку тем же списком');
  assert.deepEqual(cfg.buildSiteOpts(), {
    clearable: false,
    requireClear: true,
    yard: yard,
    villagers: []
  });
});

test('скорости и тайминги взяты из villager.js/session.js, а не выдуманы', () => {
  const cfg = loadNodeConfig();
  const villagerText = fs.readFileSync(VILLAGER_JS, 'utf8');
  const sessionText = fs.readFileSync(SESSION_JS, 'utf8');

  const vnum = (name) => parseNumberConst(villagerText, name);
  const snum = (name) => parseNumberConst(sessionText, name);

  assert.equal(cfg.constants.CHOP_TIME, vnum('CHOP_TIME'));
  assert.equal(cfg.constants.CHOP_TIME, 5);
  assert.equal(cfg.constants.TAKE_TIME, vnum('TAKE_TIME'));
  assert.equal(cfg.constants.TAKE_TIME, 1);
  assert.equal(cfg.constants.LOGS_PER_TRIP, vnum('LOGS_PER_TRIP'));
  assert.equal(cfg.constants.SHRINK, vnum('SHRINK'));
  assert.equal(cfg.constants.SPEED_STEP, vnum('SPEED_STEP'));
  assert.equal(cfg.constants.SPEED_BOOST, vnum('SPEED_BOOST'));
  assert.equal(cfg.constants.SPEED,
    vnum('SPEED_STEP') * vnum('SPEED_BOOST') / vnum('SHRINK'));
  assert.equal(cfg.constants.CHOP_HITS, vnum('CHOP_HITS'));
  assert.equal(cfg.constants.CHOP_HIT, vnum('CHOP_HIT'));
  assert.equal(cfg.constants.CHOP_HIT_EVERY,
    cfg.constants.CHOP_TIME / cfg.constants.CHOP_HITS);

  assert.equal(cfg.constants.TRAIN_TIME, snum('TRAIN_TIME'));
  assert.equal(cfg.constants.TRAIN_TIME, 5);
  assert.equal(cfg.constants.VANISH_TIME, snum('VANISH_TIME'));
  assert.equal(cfg.constants.EMERGE_TIME, snum('EMERGE_TIME'));
  assert.equal(cfg.constants.BIRTH_EVERY, snum('BIRTH_EVERY'));
  assert.equal(cfg.constants.WORK_STAND_TIME, snum('WORK_STAND_TIME'));
  assert.equal(cfg.constants.VILLAGERS, snum('VILLAGERS'));

  assert.equal(cfg.actions.chop, 5);
  assert.equal(cfg.actions.take, 1);
  assert.equal(cfg.actions.train, 5);
  assert.equal(cfg.actions.vanish, cfg.constants.VANISH_TIME);
  assert.equal(cfg.actions.emerge, cfg.constants.EMERGE_TIME);
  assert.equal(cfg.actions.birthEvery, cfg.constants.BIRTH_EVERY);
  assert.equal(cfg.actions.workStand, cfg.constants.WORK_STAND_TIME);
  assert.equal(cfg.actions.chopHitEvery, cfg.constants.CHOP_TIME / cfg.constants.CHOP_HITS);
});

test('build() детерминирован и не пишет; файл заканчивается переводом строки', () => {
  const builder = require(BUILD_TOOL);
  const beforeText = fs.readFileSync(CONFIG_PATH, 'utf8');
  const beforeMtime = fs.statSync(CONFIG_PATH).mtimeMs;

  const first = builder.build();
  const second = builder.build();

  assert.equal(first.text, second.text, 'две сборки подряд должны совпасть');
  assert.equal(first.text, beforeText, 'боевой файл должен быть уже собран');
  assert.equal(first.text.endsWith('\n'), true);
  assert.equal(first.text.endsWith('\n\n'), false, 'ровно один перевод строки в конце');
  assert.equal(first.hash, loadNodeConfig().hash);
  assert.equal(fs.statSync(CONFIG_PATH).mtimeMs, beforeMtime,
    'build() в памяти не должен трогать файл');
});

test('CLI --check: 0 на боевом файле, без записи', () => {
  const beforeText = fs.readFileSync(CONFIG_PATH, 'utf8');
  const beforeMtime = fs.statSync(CONFIG_PATH).mtimeMs;

  const result = runCheck([]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /up to date/);
  assert.match(result.stdout, /hash: [0-9a-f]{64}/);

  assert.equal(fs.readFileSync(CONFIG_PATH, 'utf8'), beforeText);
  assert.equal(fs.statSync(CONFIG_PATH).mtimeMs, beforeMtime,
    '--check не должен писать файл');
});

test('CLI --check: испорченная временная копия даёт 1 и diff; check() тоже', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '4tox-gameplay-config-'));
  try {
    const original = fs.readFileSync(CONFIG_PATH, 'utf8');
    const cfg = loadNodeConfig();
    const corrupted = original.replace('"CHOP_TIME": 5,', '"CHOP_TIME": 6,');
    assert.notEqual(corrupted, original, 'поломка для теста должна найтись в файле');

    const copyPath = path.join(dir, 'gameplay-config.js');
    fs.writeFileSync(copyPath, corrupted, 'utf8');

    const result = runCheck(['--config', copyPath]);
    assert.equal(fs.readFileSync(copyPath, 'utf8'), corrupted,
      '--check не должен «починить» проверяемую копию');
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, /OUT OF DATE/);
    assert.match(result.stderr, /CHOP_TIME/);
    assert.match(result.stderr, /первое расхождение|first difference/);
    assert.match(result.stderr, /internally inconsistent/);
    assert.match(result.stderr, /пересобрать/);

    const builder = require(BUILD_TOOL);
    const checked = builder.check({ configPath: copyPath });
    assert.equal(checked.ok, false);
    assert.ok(checked.messages.length > 0);
    assert.ok(checked.firstDifference && checked.firstDifference.line > 0);
    assert.equal(checked.expectedText, original);
    assert.equal(checked.actualText, corrupted);
    assert.equal(checked.committed.hash, cfg.hash,
      'испорчен только CHOP_TIME, поле hash осталось прежним');
    assert.notEqual(checked.committed.internalHash, checked.committed.hash,
      'данные копии больше не соответствуют записанному hash');
    assert.deepEqual(checked.committed.sourceHashes, cfg.sourceHashes);

    /* Испорченный sourceHashes тоже обязан ловиться отдельным сообщением. */
    const badSource = original.replace(
      new RegExp('"villager": "' + cfg.sourceHashes.villager + '"'),
      '"villager": "' + '0'.repeat(64) + '"'
    );
    assert.notEqual(badSource, original);
    const badSourcePath = path.join(dir, 'bad-source-hashes.js');
    fs.writeFileSync(badSourcePath, badSource, 'utf8');
    const badSourceChecked = builder.check({ configPath: badSourcePath });
    assert.equal(badSourceChecked.ok, false);
    assert.match(badSourceChecked.messages.join('\n'), /source hash mismatch \(villager\)/);
    assert.equal(badSourceChecked.committed.internalHash, cfg.hash);

    /* А несуществующий файл — тоже неуспех, а не «значит, всё хорошо». */
    const missing = builder.check({ configPath: path.join(dir, 'missing.js') });
    assert.equal(missing.ok, false);
    assert.match(missing.messages.join('\n'), /не читается/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
