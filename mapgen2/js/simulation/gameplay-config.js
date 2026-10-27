/* gameplay-config.js — СГЕНЕРИРОВАННЫЙ файл игровых данных.

   НЕ ПРАВИТЬ РУКАМИ. Источник правды:
     mapgen2/assets/villager/atlas.json (или atlas.js, если JSON нет)
     mapgen2/assets/armored_villager/atlas.json (или atlas.js, если JSON нет)
     mapgen2/js/villager.js, mapgen2/js/session.js,
     mapgen2/js/buildings.js, game/js/play.js

   Пересобрать: node mapgen2/tools/build-gameplay-config.js
   Проверить:   node mapgen2/tools/build-gameplay-config.js --check

   PNG здесь не читается: только метаданные кадров. dropDuration выведен
   из carry_put (frames / fps), а не задан числом. profiles — физические
   кадры атласа ({frames,fps,loop} на имя), logical — разрешение логических
   имён так, как его делает animResolve. UI и сервер должны читать этот конфиг.

   Источники кадров (sha256 исходного файла):
     villager: mapgen2/assets/villager/atlas.json  json  sha256 0286e65cc98a59aa39d34674cfe0f33a11ff2137a9480652f722065f7ef3c185
     warrior: mapgen2/assets/armored_villager/atlas.json  json  sha256 a4098d3bf84634982c53da33c290eaa5a357ada3cd89574f451352339bf1d1eb
   hash логических данных: 9258f5c1550e6151a9f47c3cc3fb170f6bf2767fbb7322e695b4594ae062ad3d
   dropDuration: 4 кадра / 12 fps = 0.3333333333333333 с
*/
(function (global) {
  'use strict';

  var CONFIG = {
    "configVersion": 1,
    "sourceHashes": {
      "villager": "0286e65cc98a59aa39d34674cfe0f33a11ff2137a9480652f722065f7ef3c185",
      "warrior": "a4098d3bf84634982c53da33c290eaa5a357ada3cd89574f451352339bf1d1eb"
    },
    "hash": "9258f5c1550e6151a9f47c3cc3fb170f6bf2767fbb7322e695b4594ae062ad3d",
    "dropDuration": 0.3333333333333333,
    "drop": {
      "animation": "carry_put",
      "fps": 12,
      "frames": 4,
      "loop": false,
      "profile": "villager"
    },
    "profiles": {
      "villager": {
        "carry": {
          "frames": 8,
          "fps": 12,
          "loop": true
        },
        "carry_put": {
          "frames": 4,
          "fps": 12,
          "loop": false
        },
        "idle": {
          "frames": 6,
          "fps": 8,
          "loop": true
        },
        "walk": {
          "frames": 8,
          "fps": 12,
          "loop": true
        },
        "walk_axe": {
          "frames": 8,
          "fps": 12,
          "loop": true
        },
        "work": {
          "frames": 8,
          "fps": 12,
          "loop": false
        }
      },
      "warrior": {
        "idle": {
          "frames": 6,
          "fps": 8,
          "loop": true
        },
        "walk": {
          "frames": 8,
          "fps": 12,
          "loop": true
        },
        "work": {
          "frames": 8,
          "fps": 12,
          "loop": false
        }
      }
    },
    "logical": {
      "villager": {
        "carry": "carry",
        "carry_put": "carry_put",
        "enterBarracks": "walk",
        "idle": "idle",
        "patrol": "walk",
        "take": "idle",
        "toBarracks": "walk",
        "toCamp": "walk",
        "toTree": "walk_axe",
        "toWarcamp": "walk",
        "training": "idle",
        "walk": "walk",
        "walk_axe": "walk_axe",
        "work": "work"
      },
      "warrior": {
        "carry": "walk",
        "carry_put": "idle",
        "enterBarracks": "walk",
        "idle": "idle",
        "patrol": "walk",
        "take": "idle",
        "toBarracks": "walk",
        "toCamp": "walk",
        "toTree": "walk",
        "toWarcamp": "walk",
        "training": "idle",
        "walk": "walk",
        "work": "work"
      }
    },
    "actions": {
      "appear": 0.5,
      "birthEvery": 30,
      "birthFade": 0.5,
      "birthRetry": 5,
      "chop": 5,
      "chopHitEvery": 0.625,
      "chopHitPhase": 0.5,
      "chopHits": 8,
      "drop": 0.3333333333333333,
      "emerge": 0.5,
      "take": 1,
      "train": 5,
      "vanish": 0.35,
      "workEventGap": 30,
      "workStand": 10
    },
    "prices": {
      "barracks": 28,
      "house": 12,
      "lumbercamp": 20,
      "warcamp": 24
    },
    "buildSite": {
      "clearable": false,
      "requireClear": true,
      "yard": 1
    },
    "buildings": {
      "BARRACKS_YARD_CAP": 10,
      "LINE_GAP": 1,
      "LINE_MAX": 20,
      "TRAIN_SLOTS": {
        "barracks": 3
      },
      "WARCAMP_CAP": 20,
      "YARD": 1
    },
    "constants": {
      "APPEAR_TIME": 0.5,
      "ARRIVE": 0.02,
      "BIRTH_EVERY": 30,
      "BIRTH_FADE": 0.5,
      "BIRTH_RETRY": 5,
      "CHOP_HIT": 0.5,
      "CHOP_HITS": 8,
      "CHOP_HIT_EVERY": 0.625,
      "CHOP_TIME": 5,
      "EMERGE_TIME": 0.5,
      "LOGS_PER_TRIP": 4,
      "SHRINK": 2.2,
      "SPEED": 0.63,
      "SPEED_BOOST": 1.1,
      "SPEED_STEP": 1.26,
      "STAND_OFF": 0.3,
      "TAKE_TIME": 1,
      "TRAIN_TIME": 5,
      "VANISH_TIME": 0.35,
      "VILLAGERS": 3,
      "WANDER_R": 10,
      "WANDER_RETRY": 1,
      "WORK_EVENT_GAP": 30,
      "WORK_STAND_TIME": 10
    }
  };

  /*
     Логическая анимация профиля. Возвращает то, что нужно чистой
     логике: имя реально нарисованного кадра, frames, fps, loop и
     длительность одного прохода. Разрешение имён уже посчитано при
     сборке по ANIM_FALLBACK и реальным кадрам атласа; неизвестное
     имя, как и animResolve, уходит в idle.
  */
  function animation(profileName, want) {
    var profile = Object.prototype.hasOwnProperty.call(CONFIG.profiles, profileName)
      ? CONFIG.profiles[profileName] : null;
    if (!profile) throw new Error('GameplayConfig: нет профиля "' + profileName + '"');
    if (typeof want !== 'string' || !want) throw new TypeError('GameplayConfig: имя анимации должно быть непустой строкой');
    var names = Object.prototype.hasOwnProperty.call(CONFIG.logical, profileName)
      ? CONFIG.logical[profileName] : {};
    var name = Object.prototype.hasOwnProperty.call(names, want) ? names[want] : null;
    if (!name) name = Object.prototype.hasOwnProperty.call(profile, want) ? want : 'idle';
    var anim = Object.prototype.hasOwnProperty.call(profile, name) ? profile[name] : null;
    if (!anim) throw new Error('GameplayConfig: в профиле "' + profileName + '" нет кадра "' + name + '"');
    return {
      profile: profileName,
      requested: want,
      name: name,
      frames: anim.frames,
      fps: anim.fps,
      loop: anim.loop,
      duration: anim.frames / anim.fps
    };
  }

  /*
     Опции Buildings.canPlace для покупки/постановки. Смысл BUILD_SITE
     (clearable:false, requireClear:true, yard) сохраняется, но сюда же
     попадают ЖИВЫЕ жители партии: серверная проверка обязана звать
     этот helper со своим списком, иначе дом встанет в человека.
  */
  function buildSiteOpts(villagers) {
    return {
      clearable: CONFIG.buildSite.clearable,
      requireClear: CONFIG.buildSite.requireClear,
      yard: CONFIG.buildSite.yard,
      villagers: Array.isArray(villagers) ? villagers : []
    };
  }

  /*
     Удобные имена для старых/параллельных потребителей. Они не
     перечисляются и поэтому не попадают ни в JSON, ни в hash:
     animations — кадры жителя по умолчанию (profiles.villager),
     buildPrices — синоним prices для команд сервера.
     У каждого профиля тоже есть невидимый animations, указывающий
     на него самого: код, писавший profiles.villager.animations,
     продолжает работать, а данные остаются плоскими.
  */
  var profileNames = Object.keys(CONFIG.profiles);
  for (var pi = 0; pi < profileNames.length; pi++) {
    var prof = CONFIG.profiles[profileNames[pi]];
    Object.defineProperty(prof, 'animations', { value: prof, enumerable: false });
  }
  Object.defineProperty(CONFIG, 'animations', { value: CONFIG.profiles.villager, enumerable: false });
  Object.defineProperty(CONFIG, 'buildPrices', { value: CONFIG.prices, enumerable: false });

  /* Методы не перечисляются в JSON: CONFIG остаётся чистыми данными. */
  Object.defineProperty(CONFIG, 'animation', { value: animation, enumerable: false });
  Object.defineProperty(CONFIG, 'buildSiteOpts', { value: buildSiteOpts, enumerable: false });

  global.GameplayConfig = CONFIG;
  if (typeof module !== 'undefined' && module.exports) module.exports = CONFIG;
})(typeof window !== 'undefined' ? window : globalThis);
