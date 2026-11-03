/* shape.js — форма и размеры острова без браузера.

   Что проверяет (требование заказчика 7, docs/BIG-PLAN.md §P1):

     1. доля суши в 0.60..0.80 — и на всех размерах, и на всех coast;
     2. материк один: components(world.isLand) === 1;
     3. bbox fill = площадь суши / площадь её габарита ≤ 0.80 —
        прямоугольный «блин» сюда не проходит;
     4. coast работает числом, а не «на глаз»: периметр берега при coast = 1
        больше, чем при coast = 0, не меньше чем на 15 %;
     5. на 192 находятся четыре площадки WorldGen.spawnSites(192, 4), каждая
        9 × 9 клеток (на 64 — 7 × 7, как решает движок), только трава,
        без деревьев и камней;
     6. у площадок сопоставимый лес и камень в радиусе (не «один в чаще,
        другой в голой степи»);
     7. рощи — мелкие пятна, разбросанные по суше, а не один массив;
     8. spawnSites детерминирована: тот же сид — те же площадки;
     9. лес по правилу 2026-10-24: рощ вдвое больше, средний размер не вырос,
        распределение ровнее (cv по 4×4 плиткам и число пустых плиток).

   Прогон: 5 размеров × 6 сидов × 3 coast. Браузер не нужен и не запускается.
   Код возврата 1, если хоть одна проверка не прошла. */

const WG = require('./load-worldgen.js');

const SIZES = [64, 96, 128, 192, 256];
const SEEDS = [
  'тихая-долина-701',
  'test-1',
  'abc',
  '42',
  'камень-и-вода-13',
  'размер-192'
];
const COASTS = [0, 0.5, 1];

let fails = 0;
function check(name, ok, extra) {
  if (!ok) fails++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (extra ? '   ' + extra : ''));
}

/* ------------------------------ метрики ------------------------------- */

function components(w) {
  const { width: W, height: H, isLand } = w;
  const seen = new Uint8Array(W * H);
  let count = 0;
  for (let s = 0; s < W * H; s++) {
    if (!isLand[s] || seen[s]) continue;
    count++;
    const stack = [s];
    seen[s] = 1;
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

// Периметр в 4-соседних рёбрах: каждое ребро «суша/не суша» — единица.
// За кромкой полотна считаем воду: там её и так не бывает, но пусть формула
// не зависит от того, обрезан ли массив.
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

function bboxFill(w) {
  let land = 0;
  for (let i = 0; i < w.isLand.length; i++) if (w.isLand[i]) land++;
  const b = w.landBounds;
  return land / ((b.x1 - b.x0) * (b.y1 - b.y0));
}

/* --------------------------- площадки под деревню --------------------- */

// Площадка SITE × SITE вокруг центра (9 × 9, на 64-й карте 7 × 7): трава,
// суша, без деревьев и камней. Размер берётся из движка, чтобы проверка
// не разошлась с spawnSites: на маленьком острове площадка мельче.
function siteOk(w, s) {
  const T = WG.T, half = (WG.spawnSiteSize(w) - 1) / 2;
  if (!s || s.x - half < 0 || s.y - half < 0 ||
      s.x + half >= w.width || s.y + half >= w.height) return false;
  const blocked = new Set();
  for (const o of w.objects) {
    if (o.kind !== 'tree' && o.kind !== 'stone') continue;
    blocked.add(Math.floor(o.y) * w.width + Math.floor(o.x));
  }
  for (let dy = -half; dy <= half; dy++) {
    for (let dx = -half; dx <= half; dx++) {
      const x = s.x + dx, y = s.y + dy, i = y * w.width + x;
      if (!w.isLand[i] || w.tile[i] !== T.GRASS) return false;
      if (blocked.has(i)) return false;
    }
  }
  return true;
}

// Лес вокруг площадки: точный круг radius R, как в spawnSites.
function resourcesAround(w, s, R) {
  let trees = 0, stones = 0;
  for (const o of w.objects) {
    const dx = o.x - s.x, dy = o.y - s.y;
    if (dx * dx + dy * dy > R * R) continue;
    if (o.kind === 'tree') trees++;
    else if (o.kind === 'stone' && o.variant !== 'pebble') stones++;
  }
  return { trees, stones };
}

// Пятна рощ (forestness > 0.35 — то же, что строка «роща» под курсором).
// Нужны мелкие и разбросанные: максимум одного пятна в процентах суши.
function forestStats(w) {
  const W = w.width, H = w.height, N = W * H;
  const seen = new Uint8Array(N);
  let land = 0;
  for (const v of w.isLand) if (v) land++;
  const sizes = [];
  let total = 0;
  for (let s = 0; s < N; s++) {
    if (seen[s] || !w.isLand[s] || w.forestness[s] <= 0.35) continue;
    const stack = [s];
    seen[s] = 1;
    let n = 0;
    while (stack.length) {
      const i = stack.pop();
      n++;
      const x = i % W, y = (i - x) / W;
      const push = (j) => {
        if (!seen[j] && w.isLand[j] && w.forestness[j] > 0.35) { seen[j] = 1; stack.push(j); }
      };
      if (x > 0) push(i - 1);
      if (x < W - 1) push(i + 1);
      if (y > 0) push(i - W);
      if (y < H - 1) push(i + W);
    }
    sizes.push(n);
    total += n;
  }
  sizes.sort((a, b) => b - a);
  // Ровность распределения: 4×4 плитки по суше. cv — насколько доля рощ
  // разнится от плитки к плитке, empty — плитки, где рощ нет совсем.
  const K = 4, landQ = new Float64Array(K * K), forestQ = new Float64Array(K * K);
  for (let s = 0; s < N; s++) {
    if (!w.isLand[s]) continue;
    const x = s % W, y = (s - x) / W;
    const q = Math.min(K - 1, (y * K / H) | 0) * K + Math.min(K - 1, (x * K / W) | 0);
    landQ[q]++;
    if (w.forestness[s] > 0.35) forestQ[q]++;
  }
  const parts = [];
  for (let q = 0; q < K * K; q++) if (landQ[q] > land * 0.01) parts.push(forestQ[q] / landQ[q]);
  const pm = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : 0;
  const cv = parts.length
    ? Math.sqrt(parts.reduce((a, b) => a + (b - pm) ** 2, 0) / parts.length) / (pm || 1) : 0;
  return {
    patches: sizes.length,
    share: land ? total / land : 0,
    maxShare: land && sizes.length ? sizes[0] / land : 0,
    mean: sizes.length ? total / sizes.length : 0,
    cv: cv,
    empty: parts.filter(v => v < 0.002).length
  };
}

function checkSites(w, label) {
  const sites = WG.spawnSites(w, 4);
  check(`спавн-площадки ${label}: четыре ${WG.spawnSiteSize(w)}×${WG.spawnSiteSize(w)}`, sites.length === 4,
    'найдено ' + sites.length + (sites.length ? ': ' + sites.map(s => s.x + ',' + s.y).join(' ') : ''));
  if (sites.length !== 4) return;
  let bad = 0;
  for (const s of sites) if (!siteOk(w, s)) bad++;
  check(`спавн-площадки ${label}: только трава, без деревьев/камней`, bad === 0, bad + ' плохих');
  // Разброс: точки не в одной куче. Порог мягкий — 10 % острова.
  let minD = Infinity;
  for (let i = 0; i < sites.length; i++) {
    for (let j = i + 1; j < sites.length; j++) {
      minD = Math.min(minD, Math.hypot(sites[i].x - sites[j].x, sites[i].y - sites[j].y));
    }
  }
  const want = Math.round((w.islandSize || w.width) * 0.10);
  check('спавн-площадки ' + label + ': разнесены (' + want + '+)', minD >= want,
    'минимум ' + minD.toFixed(1) + ' клеток');

  // Лес и камень у каждой площадки — в сопоставимом радиусе и количестве.
  const R = Math.max(10, Math.round((w.islandSize || w.width) * 0.12));
  const res = sites.map(s => resourcesAround(w, s, R));
  const treeMin = Math.min.apply(null, res.map(r => r.trees));
  const treeMax = Math.max.apply(null, res.map(r => r.trees));
  const stoneMin = Math.min.apply(null, res.map(r => r.stones));
  check('спавн-площадки ' + label + ': у каждой есть лес в радиусе ' + R,
    treeMin > 0, res.map(r => r.trees).join(' / '));
  check('спавн-площадки ' + label + ': лес у площадок сопоставим (≤ 6×)',
    treeMax <= Math.max(1, treeMin) * 6, treeMin + '..' + treeMax);
  check('спавн-площадки ' + label + ': камень есть у каждой',
    stoneMin > 0, res.map(r => r.stones).join(' / '));

  const fs = forestStats(w);
  check('лес ' + label + ': мелкие пятна, не один массив',
    fs.patches >= 4 && fs.maxShare <= 0.08,
    fs.patches + ' пятен, максимум ' + (fs.maxShare * 100).toFixed(1) + ' % суши');
  check('лес ' + label + ': доля суши под рощами разумна',
    fs.share >= 0.02 && fs.share <= 0.30,
    (fs.share * 100).toFixed(1) + ' %');
}

/* ------------------------------- прогон -------------------------------- */

const times = {};
// Лес накапливается по всем картам размера: правило заказчика 2026-10-24
// проверяется в среднем, а не по одной карте (на одном сиде «средний размер»
// гуляет сам по себе — так было и до правила).
const forestAgg = {};

console.log('=== форма острова: 5 размеров × 6 сидов × coast 0 / 0.5 / 1 ===');
for (const size of SIZES) {
  let sumMs = 0, nMs = 0;
  console.log('\n' + size + '×' + size);
  console.log('  сид                       coast 0            coast 0.5          coast 1            c1/c0');
  for (const seed of SEEDS) {
    let row = [];
    for (const coast of COASTS) {
      const w = WG.generate({ seed, size, coast });
      sumMs += w.genTimeMs; nMs++;
      const m = {
        size, seed, coast,
        land: w.stats.landShare,
        comp: components(w),
        fill: bboxFill(w),
        perim: perimeter(w),
        w
      };
      row.push(m);
      const fsx = forestStats(w);
      const agg = forestAgg[size] || (forestAgg[size] = { patches: [], mean: [], share: [], cv: [], empty: [] });
      agg.patches.push(fsx.patches);
      agg.mean.push(fsx.mean);
      agg.share.push(fsx.share);
      agg.cv.push(fsx.cv);
      agg.empty.push(fsx.empty);
    }
    const [a, b, c] = row;
    const ratio = a.perim ? c.perim / a.perim : 0;
    console.log('  ' + seed.padEnd(24) +
      fmt(a) + '  ' + fmt(b) + '  ' + fmt(c) + '  ' + ratio.toFixed(2) + '×');
    check(`${size}/${seed}: доля суши 0.60..0.80`, row.every(m => m.land >= 0.60 && m.land <= 0.80),
      row.map(m => (m.land * 100).toFixed(1) + ' %').join(' / '));
    check(`${size}/${seed}: материк один`, row.every(m => m.comp === 1),
      row.map(m => m.comp).join(' / '));
    check(`${size}/${seed}: bbox fill ≤ 0.80`, row.every(m => m.fill <= 0.80),
      row.map(m => m.fill.toFixed(3)).join(' / '));
    check(`${size}/${seed}: coast 1 → периметр +15 %`, ratio >= 1.15, ratio.toFixed(3) + '×');
    if (size === 192) {
      checkSites(a.w, `192/${seed}/c0`);
      checkSites(b.w, `192/${seed}/c0.5`);
      checkSites(c.w, `192/${seed}/c1`);
    }
  }
  times[size] = sumMs / nMs;
}

/* --- лес: вдвое больше, размер тот же, ровнее -------------------------- *
 *
 * Заказчик (2026-10-24): «в два раза больше лесов, не увеличивая средний
 * размер леса» и «чтобы леса распределялись так же рандомно и естественно,
 * но более равномерно».
 *
 * Опорные числа FOREST_BEFORE — замер ТЕМ ЖЕ способом (forestStats по тем же
 * 6 сидам × coast 0/0.5/1) на коде до правила. Сравнение идёт по среднему на
 * размер: у отдельной карты и число пятен, и средний размер зависят от сида
 * сильнее, чем от правила (разброс был и раньше: 16..37 пятен на 256).
 * ------------------------------------------------------------------ */
console.log('\n=== лес: вдвое больше, средний размер прежний, распределение ровнее ===');
const FOREST_BEFORE = {
  64: { patches: 21.5, mean: 8.5, share: 0.068 },
  96: { patches: 24.2, mean: 15.6, share: 0.066 },
  128: { patches: 25.2, mean: 26.4, share: 0.064 },
  192: { patches: 25.5, mean: 57.2, share: 0.063 },
  256: { patches: 26.2, mean: 99.1, share: 0.063 }
};
const forestAverages = {};
for (const size of SIZES) {
  const agg = forestAgg[size], was = FOREST_BEFORE[size];
  const avg = (key) => agg[key].reduce((s, v) => s + v, 0) / agg[key].length;
  const patchRatio = avg('patches') / was.patches;
  const meanRatio = avg('mean') / was.mean;
  const shareRatio = avg('share') / was.share;
  forestAverages[size] = { patchRatio, meanRatio, shareRatio, cv: avg('cv'), empty: avg('empty') };
  console.log('  ' + String(size).padStart(3) + ': пятен ' +
    (patchRatio).toFixed(2) + '×, средний размер ' + meanRatio.toFixed(2) +
    '×, доля суши ' + shareRatio.toFixed(2) + '×, cv ' + avg('cv').toFixed(2) +
    ', пустых плиток ' + avg('empty').toFixed(2));
  check(`лес ${size}: рощ примерно вдвое больше (1.7..2.35×)`,
    patchRatio >= 1.7 && patchRatio <= 2.35, patchRatio.toFixed(2) + '×');
  check(`лес ${size}: средний размер не вырос (≤ 1.10×)`,
    meanRatio <= 1.10, meanRatio.toFixed(2) + '×');
  check(`лес ${size}: доля суши под рощами ×1.6..2.3`,
    shareRatio >= 1.6 && shareRatio <= 2.3, shareRatio.toFixed(2) + '×');
  check(`лес ${size}: распределение ровнее (cv ≤ 0.80, пустых ≤ 2)`,
    avg('cv') <= 0.80 && avg('empty') <= 2,
    'cv ' + avg('cv').toFixed(2) + ', пустых ' + avg('empty').toFixed(2));
}

/* Детерминизм площадок: тот же сид и coast — те же точки. */
console.log('\n=== детерминизм spawnSites ===');
for (const size of SIZES) {
  const seed = 'детерминизм-формы';
  const a = WG.spawnSites(WG.generate({ seed, size, coast: 0.5 }), 4);
  const b = WG.spawnSites(WG.generate({ seed, size, coast: 0.5 }), 4);
  check(`${size}: тот же сид — те же площадки`, JSON.stringify(a) === JSON.stringify(b),
    JSON.stringify(a));
}

console.log('\n=== время генерации (внутренний genTimeMs) ===');
for (const size of SIZES) {
  console.log('  ' + size + '×' + size + ': ' + times[size].toFixed(0) + ' мс в среднем');
}

console.log('\n' + (fails ? 'ПРОВАЛЕНО проверок: ' + fails : 'все проверки пройдены'));
process.exit(fails ? 1 : 0);

function fmt(m) {
  return (m.land * 100).toFixed(1).padStart(5) + ' % ' +
    m.fill.toFixed(2) + ' ' + String(m.perim).padStart(4);
}
