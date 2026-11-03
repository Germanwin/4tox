/* combat-digest.test.js — «бой не изменился» в общем прогоне `node --test`.

   Сама сверка живёт в combat-digest.js (её же можно позвать руками и переснять
   эталон ключом --write). Здесь она просто входит в обязательный прогон:
   отпечаток боя на фиксированном мире должен совпадать с эталоном
   `fixtures/combat-digest.json`, иначе правка поменяла цели, урон или
   движение — и принимать её нельзя, даже если она быстрее. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const digest = require('./combat-digest.js');

test('бой тот же: отпечаток совпадает с эталоном', () => {
  const ref = JSON.parse(fs.readFileSync(digest.FIXTURE, 'utf8'));
  const now = digest.run();
  assert.strictEqual(now.villagers, ref.villagers, 'число жителей в бою');
  assert.strictEqual(now.warriors, ref.warriors, 'число воинов в бою');
  assert.strictEqual(now.hash, ref.hash,
    'отпечаток боя разошёлся с эталоном: правка меняет цели/урон/движение. ' +
    'Если изменение боевых правил намеренное — переснимите эталон: ' +
    'node game/tools/tests/combat-digest.js --write');
});
