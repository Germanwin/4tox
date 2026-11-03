/* export_world.js — статический мир к фикстуре.

   Берёт seed/size из start.json (снят с живого сервера), генерирует тот же
   остров тем же mapgen2/js/worldgen.js и проверяет hashWorld: он обязан
   совпасть с worldgenHash из снимка сервера. Если не совпал — это не тот
   мир, и рендер сверять не с чем.

   Результат: godot/tests/fixtures/world.json — тайлы, isLand, distLand,
   distWater и объекты природы. Для M1 грузится из файла; в M2 то же самое
   поедет с сервера (WLD1), клиент генерировать остров не будет.

   Запуск: node godot/tests/export_world.js */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
global.window = global;
require(path.join(REPO, 'mapgen2/js/rng.js'));
require(path.join(REPO, 'mapgen2/js/noise.js'));
require(path.join(REPO, 'mapgen2/js/worldgen.js'));
const WG = global.WorldGen;

const DIR = process.env.TOX_OUT
  ? path.resolve(process.env.TOX_OUT)
  : path.join(__dirname, 'fixtures');
const start = JSON.parse(fs.readFileSync(path.join(DIR, 'start.json'), 'utf8'));
const snap = start.start.baseline;

const world = WG.generate({ seed: snap.seed, size: snap.size });
const hash = WG.hashWorld(world);
if (hash !== snap.worldgenHash) {
  console.error('мир не тот: hash ' + hash + ' != ' + snap.worldgenHash);
  process.exit(1);
}

const round = (v, n) => {
  const k = Math.pow(10, n);
  return Math.round(v * k) / k;
};

const out = {
  format: '4tox-world-json',
  version: 1,
  seed: snap.seed,
  size: snap.size,
  worldgenHash: hash,
  width: world.width,
  height: world.height,
  islandSize: world.islandSize,
  waterThreshold: world.waterThreshold,
  tile: Array.from(world.tile),
  isLand: Array.from(world.isLand),
  distLand: Array.from(world.distLand, (v) => round(v, 3)),
  distWater: Array.from(world.distWater, (v) => round(v, 3)),
  objects: world.objects.map((o) => ({
    kind: o.kind,
    variant: o.variant === undefined ? null : o.variant,
    x: round(o.x, 3),
    y: round(o.y, 3),
    scale: round(o.scale, 4),
    phase: round(o.phase, 4),
    id: o.id
  }))
};

const file = path.join(DIR, 'world.json');
fs.writeFileSync(file, JSON.stringify(out));
const stat = fs.statSync(file);
const kinds = {};
for (const o of world.objects) kinds[o.kind] = (kinds[o.kind] || 0) + 1;
console.log('мир: ' + world.width + 'x' + world.height + ', island ' + world.islandSize +
  ', hash ' + hash + ' (совпал с сервером)');
console.log('объекты: ' + world.objects.length + ' ' + JSON.stringify(kinds));
console.log('файл: ' + path.relative(REPO, file) + ', ' + (stat.size / 1024 / 1024).toFixed(2) + ' МБ');
