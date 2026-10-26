/* chrome.js — один адрес Chrome для всех браузерных приёмок.

   Зачем. Пятнадцать приёмок (`mapgen2/tools/*.js` и `game/tools/*.js`) знали
   один и тот же путь `/Applications/Google Chrome.app/...` — путь macOS. На
   Linux и Windows они падали ещё до запуска браузера, а на маке не давали
   выбрать другой Chrome. Теперь адрес ищется в одном месте и в одном порядке:

     1. окружение `CHROME_PATH` — явный выбор, главнее всего. Задан, но файла
        нет — это ошибка с подсказкой, а не молчаливый возврат к поиску: иначе
        опечатка в переменной выглядела бы как «Chrome не установлен»;
     2. известные места macOS и Windows (включая `Program Files (x86)`);
     3. имена в `PATH`: google-chrome, chromium, chromium-browser (Linux) и
        chrome (Windows);
     4. внятная ошибка с примером запуска.

   Модуль отдаёт СТРОКУ пути — ровно то, что раньше лежало в константе
   `CHROME`, поэтому приёмки не меняют поведения: `spawn(CHROME, ...)` и
   `executablePath: CHROME` работают как работали.

   Проверить, что видит приёмка, можно без браузера:
     node mapgen2/tools/chrome.js
   Печатает путь и код возврата 0; если Chrome не найден — причину и код 1. */

'use strict';

const fs = require('fs');
const path = require('path');

/* Известные места. Сначала macOS (там приёмки и писались), потом Windows:
   путь в `Program Files` и `Program Files (x86)` — оба нужны, потому что
   32-битная установка на 64-битной системе живёт во втором. */
const MAC_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium'
];
if (process.env.HOME) {
  MAC_PATHS.push(path.join(process.env.HOME, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'));
}

/* Обычные места Linux. PATH ниже тоже проверяется, но эти пути полезны, когда
   приёмку зовут из cron/CI с урезанным PATH. */
const LINUX_PATHS = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/opt/google/chrome/chrome'
];

function windowsPaths() {
  const out = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
  ];
  const pf = process.env.ProgramFiles;
  const pf86 = process.env['ProgramFiles(x86)'];
  const local = process.env.LOCALAPPDATA;
  if (pf) out.push(path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  if (pf86) out.push(path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  if (local) out.push(path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  return out;
}

/* Имена для поиска в PATH. На Linux это и есть обычная установка из
   репозитория; на Windows — установка, добавленная в PATH вручную. */
const PATH_NAMES = process.platform === 'win32'
  ? ['chrome', 'chrome.exe']
  : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];

function isFile(p) {
  if (!p) return false;
  try {
    return fs.statSync(p).isFile();
  } catch (e) {
    return false;
  }
}

function searchPath() {
  const dirs = String(process.env.PATH || '').split(path.delimiter);
  for (const name of PATH_NAMES) {
    for (const dir of dirs) {
      if (!dir) continue;
      const p = path.join(dir, name);
      if (isFile(p)) return p;
    }
  }
  return null;
}

function hint() {
  return [
    'Chrome не найден.',
    'Укажите его путь явно:',
    '  CHROME_PATH="/путь/к/chrome" node mapgen2/tools/game.js',
    'macOS:  /Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'Linux:  google-chrome, chromium или chromium-browser в PATH',
    'Windows: C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'Проверить, что видит приёмка: node mapgen2/tools/chrome.js'
  ].join('\n');
}

function resolveChrome() {
  const env = (process.env.CHROME_PATH || '').trim();
  if (env) {
    if (isFile(env)) return env;
    throw new Error('CHROME_PATH указывает на несуществующий файл: ' + env + '\n' + hint());
  }

  const known = process.platform === 'win32' ? windowsPaths()
    : process.platform === 'darwin' ? MAC_PATHS
    : LINUX_PATHS;
  for (const p of known) {
    if (isFile(p)) return p;
  }

  const found = searchPath();
  if (found) return found;

  throw new Error(hint());
}

let resolved;
try {
  resolved = resolveChrome();
} catch (e) {
  if (require.main === module) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
}

module.exports = resolved;

if (require.main === module) {
  /* Печатаем ровно путь: эту строку удобно подставлять в CHROME_PATH и в
     скрипты проверки, не разбирая текст. */
  console.log(resolved);
}
