/* test_constants.js — `godot/data/constants.json` совпадает с JS.
 *
 * Числа игры (цены, вместимости, время тренировки, пороги мыши, зум,
 * длительности анимаций) обязаны приходить из браузерного кода, а не быть
 * переписанными руками в GDScript. Тест пересобирает их генератором и
 * сравнивает с файлом; расхождение — это либо забытая перегенерация, либо
 * правка баланса, которая до клиента не доехала.
 *
 * Запуск: node godot/tests/test_constants.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const GEN = require(path.join(__dirname, '..', 'tools', 'gen_constants.js'));
const FILE = GEN.OUT;

let fails = 0;
let checks = 0;
function check(ok, name, extra) {
  checks++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (extra ? '   ' + extra : ''));
  if (!ok) fails++;
}

(function main() {
  const want = GEN.build();
  check(fs.existsSync(FILE), 'constants.json собран', FILE);
  if (!fs.existsSync(FILE)) {
    console.log('== провалов ' + fails);
    process.exit(1);
  }
  const have = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  /* generatedAt меняется каждый запуск — это метка, а не правило. */
  delete want.generatedAt;
  delete have.generatedAt;

  const keys = ['zoom', 'input', 'buildMenu', 'caps', 'slots', 'trainTime',
    'housing', 'combat', 'anim'];
  for (const k of keys) {
    check(JSON.stringify(have[k]) === JSON.stringify(want[k]),
      'раздел ' + k + ' совпадает с JS',
      k === 'buildMenu' ? have[k].map(function (b) { return b.type + ':' + b.price; }).join(',') : '');
  }
  check(have.buildMenu.length === 4, 'четыре карточки стройки');
  check(have.buildMenu.every(function (b) { return typeof b.price === 'number'; }),
    'у каждой карточки есть цена');
  check(have.trainTime === 5, 'тренировка 5 с');
  check(have.caps.warcamp === 20 && have.caps.barracksYard === 10, 'вместимости 20/10');
  check(have.zoom.min === 3 && have.zoom.max === 120, 'зум 3..120');
  check(have.input.clickSlop === 8 && have.input.holdSlop === 18,
    'пороги мыши 8/18');
  check(have.anim && have.anim.villager && have.anim.villager.walk.duration > 0,
    'длительности анимаций есть');

  console.log('== проверок ' + checks + ', провалов ' + fails);
  if (fails === 0) console.log('ALL CONSTANTS TESTS PASSED');
  process.exit(fails === 0 ? 0 : 1);
})();
