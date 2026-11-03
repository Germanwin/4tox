/* noise.js — value-noise + fBm.
   Чистый хеш от координат, без таблиц перестановок: любую точку можно
   посчитать независимо от соседей. Это важно, когда поля считаются
   по регионам, а не одной простыней. */
(function (global) {
  'use strict';

  function hash2i(x, y, seed) {
    var h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  // Квинтическая интерполяция: вторая производная на стыках клеток нулевая,
  // поэтому у поля не видно «решётки» — только плавные пятна.
  function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }

  function value2(x, y, seed) {
    var xi = Math.floor(x), yi = Math.floor(y);
    var xf = x - xi, yf = y - yi;
    var u = fade(xf), v = fade(yf);
    var a = hash2i(xi, yi, seed);
    var b = hash2i(xi + 1, yi, seed);
    var c = hash2i(xi, yi + 1, seed);
    var d = hash2i(xi + 1, yi + 1, seed);
    var top = a + (b - a) * u;
    var bot = c + (d - c) * u;
    return top + (bot - top) * v;
  }

  function fbm2(x, y, seed, oct, lac, gain) {
    oct = oct || 4; lac = lac || 2; gain = gain === undefined ? 0.5 : gain;
    var amp = 1, freq = 1, sum = 0, norm = 0;
    for (var i = 0; i < oct; i++) {
      sum += amp * value2(x * freq, y * freq, (seed + i * 1013) | 0);
      norm += amp;
      amp *= gain;
      freq *= lac;
    }
    return sum / norm;
  }

  // Хребтовый шум: даёт вытянутые гряды вместо круглых холмов.
  // Берег из него получается с косами и заливами, а не с ровной кромкой.
  function ridged2(x, y, seed, oct, lac, gain) {
    oct = oct || 4; lac = lac || 2; gain = gain === undefined ? 0.5 : gain;
    var amp = 1, freq = 1, sum = 0, norm = 0;
    for (var i = 0; i < oct; i++) {
      var v = value2(x * freq, y * freq, (seed + i * 7919) | 0);
      var r = 1 - Math.abs(v * 2 - 1);
      sum += amp * r * r;
      norm += amp;
      amp *= gain;
      freq *= lac;
    }
    return sum / norm;
  }

  global.Noise = { hash2i: hash2i, value2: value2, fbm2: fbm2, ridged2: ridged2 };
})(typeof window !== 'undefined' ? window : globalThis);
