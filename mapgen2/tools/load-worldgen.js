/* load-worldgen.js — подключает браузерные модули генератора в node.
   Модули написаны как IIFE поверх globalThis и не зависят от DOM,
   поэтому их достаточно выполнить в общем контексте.

   Именно в общем, а не в vm-песочнице: в песочнице тот же код медленнее
   в двадцать раз (кросс-контекстные типизированные массивы не
   оптимизируются), и раздел «производительность» в smoke.js мерил бы
   песочницу, а не генератор. Ради этого замера загрузчик и переписан. */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'js');
const files = ['noise.js', 'rng.js', 'worldgen.js'];

for (const f of files) {
  const code = fs.readFileSync(path.join(root, f), 'utf8');
  // new Function — своя область видимости, но тот же глобальный объект:
  // модули сами вешают себя на globalThis.
  new Function(code + '\n//# sourceURL=' + f)();
}

module.exports = globalThis.WorldGen;
