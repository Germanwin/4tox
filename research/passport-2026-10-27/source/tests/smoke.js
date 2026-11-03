/* smoke.js — прогон генератора без браузера.
   Проверяет инварианты, которые легко сломать при правке: доля суши,
   связность материка, объекты не в воде и то, что coast 1 даёт берег
   длиннее (по числу рёбер), чем coast 0. */

const WG = require('./load-worldgen.js');

let fails = 0;
function check(name, ok, extra) {
  if (!ok) fails++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (extra ? '   ' + extra : ''));
}

function run(seed, size, over) {
  const p = Object.assign({ seed, size }, over || {});
  const w = WG.generate(p);
  const s = w.stats;

  console.log(`\n${seed}  ${size}×${size}  ${w.genTimeMs.toFixed(0)} мс`);
  console.log(`  суша ${(s.landShare * 100).toFixed(1)} %  деревья ${s.trees}  камни ${s.rocks}` +
    `  россыпь ${s.smallRocks}  мелочь ${s.decor}`);

  // Ожидания масштабируются по размеру карты и по ползункам: «без леса»
  // и «без камня» — это осознанные настройки, а не поломка генератора.
  const k = (size * size) / (64 * 64);
  // Деревьев не может быть больше, чем позволяет суша: на карте с 35 %
  // суши их и должно быть примерно вдвое меньше, чем на 62 %.
  const landFactor = Math.min(1, s.landShare / 0.62);
  const wantTrees = (p.forest === 0 || p.trees === 0) ? 0 : Math.round(120 * k * landFactor);
  const wantRocks = (p.rock === 0) ? 0 : Math.max(6, Math.round(15 * k * landFactor));

  // Сверху доля суши ограничена водной рамкой по краю карты: запрошенные
  // 90 % на 64×64 недостижимы в принципе, и это не ошибка генератора.
  const target = Math.min(p.land === undefined ? WG.DEFAULTS.land : p.land, w.maxLandShare);
  check('доля суши близка к заданной', Math.abs(s.landShare - target) < 0.05,
    `${(s.landShare * 100).toFixed(1)} % vs ${(target * 100).toFixed(0)} %`);
  check('суша есть', s.landTiles > 100);
  check('вода по краям', edgeWater(w) > 0.97, (edgeWater(w) * 100).toFixed(0) + ' % рамки');
  check('материк один', components(w) === 1, components(w) + ' кусков');
  check('деревьев достаточно', s.trees >= wantTrees, s.trees + ' (нужно ≥ ' + wantTrees + ')');
  check('камни есть', s.mineable >= wantRocks, s.mineable + ' (нужно ≥ ' + wantRocks + ')');

  let inWater = 0;
  for (const o of w.objects) {
    const tx = Math.floor(o.x), ty = Math.floor(o.y);
    if (!w.isLand[ty * w.width + tx]) inWater++;
  }
  check('объекты не в воде', inWater === 0, inWater + ' шт.');

  // Деревья стоят по полю леса, а не равномерно: там, где лес гуще,
  // на клетку должно приходиться заметно больше деревьев.
  if (wantTrees > 0) {
    const ratio = forestContrast(w);
    check('деревья собираются в рощи', ratio > 2.2, 'в роще/вне ' + ratio.toFixed(1) + '×');
  }

  return w;
}

function edgeWater(w) {
  const { width: W, height: H, isLand } = w;
  let water = 0, total = 0;
  for (let x = 0; x < W; x++) {
    for (const y of [0, H - 1]) { total++; if (!isLand[y * W + x]) water++; }
  }
  for (let y = 0; y < H; y++) {
    for (const x of [0, W - 1]) { total++; if (!isLand[y * W + x]) water++; }
  }
  return water / total;
}

function components(w) {
  const { width: W, height: H, isLand } = w;
  const seen = new Uint8Array(W * H);
  let count = 0;
  for (let s = 0; s < W * H; s++) {
    if (!isLand[s] || seen[s]) continue;
    count++;
    const stack = [s]; seen[s] = 1;
    while (stack.length) {
      const i = stack.pop(), x = i % W, y = (i - x) / W;
      const push = (j) => { if (isLand[j] && !seen[j]) { seen[j] = 1; stack.push(j); } };
      if (x > 0) push(i - 1);
      if (x < W - 1) push(i + 1);
      if (y > 0) push(i - W);
      if (y < H - 1) push(i + W);
    }
  }
  return count;
}

// Периметр берега в 4-соседних рёбрах «суша/вода». Нужен как ЧИСЛО, а не
// «на глаз»: ползунок coast обязан увеличивать изрезанность, а не только
// менять картинку. За кромкой карты — вода (её там и так нет).
function perimeter(w) {
  const { width: W, height: H, isLand } = w;
  let p = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!isLand[i]) continue;
      if (x === 0 || !isLand[i - 1]) p++;
      if (x === W - 1 || !isLand[i + 1]) p++;
      if (y === 0 || !isLand[i - W]) p++;
      if (y === H - 1 || !isLand[i + W]) p++;
    }
  }
  return p;
}

// Во сколько раз плотность деревьев в рощах выше, чем на остальной суше
function forestContrast(w) {
  const { width: W, tile, forestness, objects } = w;
  const T = WG.T;
  let inTrees = 0, inTiles = 0, outTrees = 0, outTiles = 0;
  for (let i = 0; i < tile.length; i++) {
    if (tile[i] !== T.GRASS) continue;
    if (forestness[i] > 0.5) inTiles++; else outTiles++;
  }
  for (const o of objects) {
    if (o.kind !== 'tree') continue;
    const i = Math.floor(o.y) * W + Math.floor(o.x);
    if (forestness[i] > 0.5) inTrees++; else outTrees++;
  }
  if (!inTiles || !outTiles) return 0;
  const a = inTrees / inTiles, b = outTrees / outTiles;
  return b > 0 ? a / b : 99;
}

console.log('=== базовые сиды ===');
const seeds = ['тихая-долина-701', 'test-1', 'abc', '42', 'камень-и-вода-13'];
for (const s of seeds) run(s, 64);

console.log('\n=== размеры ===');
for (const size of [48, 96, 128]) run('размер-' + size, size);

console.log('\n=== крайности ползунков ===');
run('мало-суши', 64, { land: 0.35 });
run('много-суши', 64, { land: 0.9 });
const smoothCoast = run('ровный-берег', 64, { coast: 0 });
const roughCoast = run('рваный-берег', 64, { coast: 1 });
// coast 0 — гладкий овал, coast 1 — рваный берег. Проверяем именно число:
// рваный берег обязан дать заметно больше рёбер «суша/вода», иначе ползунок
// «изрезанность» снова управляет квадратностью, а не берегом.
const per0 = perimeter(smoothCoast), per1 = perimeter(roughCoast);
check('coast 1 даёт периметр больше coast 0 (≥ 15 %)', per1 >= per0 * 1.15,
  per0 + ' → ' + per1 + ' (' + ((per1 / per0 - 1) * 100).toFixed(1) + ' %)');
run('без-леса', 64, { forest: 0, trees: 0 });
run('без-камня', 64, { rock: 0 });
run('всё-по-максимуму', 64, { forest: 1, trees: 1, rock: 1, rocks: 1 });

console.log('\n=== детерминизм ===');
const a = JSON.stringify(run('детерминизм', 48).objects.map(o => [o.kind, o.variant, o.x.toFixed(4), o.y.toFixed(4)]));
const b = JSON.stringify(run('детерминизм', 48).objects.map(o => [o.kind, o.variant, o.x.toFixed(4), o.y.toFixed(4)]));
check('один сид — одна карта', a === b);

console.log('\n=== производительность (128×128, node без JIT браузера) ===');
// Первый прогон — разогрев: в vm-песочнице он в разы дороже остальных,
// и среднее по пяти уходит в случайную сторону. Меряем лучший.
let bestPerf = Infinity;
for (let i = 0; i < 6; i++) {
  const t0 = Date.now();
  WG.generate({ seed: 'perf-' + i, size: 128 });
  const dt = Date.now() - t0;
  if (i > 0 && dt < bestPerf) bestPerf = dt;
}
console.log('  ' + bestPerf + ' мс на карту (лучший из пяти)');

console.log('\n' + (fails ? 'ПРОВАЛЕНО проверок: ' + fails : 'все проверки пройдены'));
process.exit(fails ? 1 : 0);
