/* ruins.js — приёмка атласа завалов: 5 типов × 4 поворота, точки опоры.

   Картинку не декодируем: проверяем метаданные и сборку набора тем же
   Buildings.build, что и в игре. Это ловит разъехавшиеся anchor/ground/
   footprint, из-за которых руина встала бы со сдвигом.

   Запуск: node mapgen2/tools/ruins.js */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'assets');
globalThis.window = globalThis;
new Function(fs.readFileSync(path.join(ASSETS, 'ruins/atlas.js'), 'utf8'))();
new Function(fs.readFileSync(path.join(ROOT, 'js/buildings.js'), 'utf8'))();
const B = globalThis.Buildings, meta = globalThis.RUINS_ATLAS;
let fails = 0;
function check(ok, text) { console.log((ok ? '  ok   ' : '  FAIL ') + text); if (!ok) fails++; }
check(!!meta && !!meta.types, 'атлас завалов объявлен');
if (meta && meta.types) {
  const types = Object.keys(meta.types);
  check(types.length === 5, 'пять типов: ' + types.join(', '));
  const img = { width: 1, height: 1 };
  let frames = 0, bad = 0;
  for (const type of types) {
    const t = meta.types[type], sub = { ppu: t.ppu, az_deg: meta.az_deg,
      el_deg: meta.el_deg, mul: t.mul, cell: meta.cell, variants: {}, frames: {} };
    sub.variants[type] = t.footprint;
    for (const name in meta.frames) {
      const f = meta.frames[name];
      if (f.variant === type) { sub.frames[name] = f; frames++; }
    }
    B.build('ruins:' + type, img, sub);
    const set = B.sets['ruins:' + type];
    check(!!set, type + ': набор собран');
    if (!set) { bad++; continue; }
    let n = 0;
    for (const rot of [0, 90, 180, 270]) {
      const s = B.sprite(set, type, rot);
      if (!s || !(s.ax > 0) || !(s.ay > 0) || !s.ground) bad++;
      else n++;
    }
    check(n === 4, type + ': 4 поворота с точкой опоры и ground');
    check(set.ppu === t.ppu && set.mul === t.mul, type + ': ppu/mul совпали');
  }
  check(frames === 20 && bad === 0, '20 кадров собраны без потерь');
}
console.log(fails ? '\nПРОВАЛЕНО проверок: ' + fails : '\nЗАВАЛЫ ПРИНЯТЫ');
process.exit(fails ? 1 : 0);
