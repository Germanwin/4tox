/* rng.js — детерминированный ГПСЧ.
   Один и тот же сид даёт одну и ту же карту всегда и на любом устройстве. */
(function (global) {
  'use strict';

  // Строка -> 32-битный целочисленный сид (FNV-1a)
  function hashString(str) {
    var h = 2166136261 >>> 0;
    str = String(str);
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  /* mulberry32 с ЯВНЫМ состоянием.

     Раньше состояние жило в замыкании `_next`, и сохранить его было нечем:
     checkpoint восстанавливал генератор с исходного seed, а это не
     продолжение прежней последовательности, а её начало. Теперь состояние —
     обычное числовое поле `_state`, его можно записать и прочитать.

     Алгоритм не изменился ни на бит: те же +0x6D2B79F5, те же сдвиги и то же
     деление. 10 000 значений старого и нового генератора для числовых и
     строковых seed совпадают — это закреплено тестом. */
  function RNG(seed) {
    this.seed = (typeof seed === 'number') ? (seed >>> 0) : hashString(seed);
    this._state = this.seed | 0;
  }

  RNG.prototype.next = function () {
    this._state = (this._state + 0x6D2B79F5) | 0;
    var t = Math.imul(this._state ^ (this._state >>> 15), 1 | this._state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  RNG.prototype.range = function (a, b) { return a + (b - a) * this.next(); };
  RNG.prototype.int = function (a, b) { return a + Math.floor(this.next() * (b - a + 1)); };
  RNG.prototype.chance = function (p) { return this.next() < p; };
  RNG.prototype.pick = function (arr) { return arr[Math.min(arr.length - 1, Math.floor(this.next() * arr.length))]; };
  RNG.prototype.sign = function () { return this.next() < 0.5 ? -1 : 1; };

  RNG.prototype.weighted = function (weights) {
    var total = 0, i;
    for (i = 0; i < weights.length; i++) total += weights[i];
    var r = this.next() * total;
    for (i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r <= 0) return i;
    }
    return weights.length - 1;
  };

  /* Снимок состояния. `seed` хранится отдельно от `state`: по нему видно, из
     какого сида генератор начался, а `state` — где он сейчас. Оба числа
     беззнаковые 32-битные. */
  RNG.prototype.getState = function () {
    return { seed: this.seed >>> 0, state: this._state >>> 0 };
  };

  RNG.fromState = function (data) {
    if (!data || !Number.isInteger(data.seed) || !Number.isInteger(data.state) ||
        data.seed < 0 || data.seed > 0xffffffff ||
        data.state < 0 || data.state > 0xffffffff) {
      throw new Error('invalid_rng_state');
    }
    var rng = new RNG(data.seed);
    rng._state = data.state | 0;
    return rng;
  };

  var ADJ = ['тихая', 'зелёная', 'каменная', 'мокрая', 'северная', 'кривая', 'старая',
    'новая', 'дикая', 'вольная', 'тенистая', 'туманная', 'звонкая', 'рыжая', 'студёная'];
  var NOUN = ['долина', 'заводь', 'бор', 'брод', 'перевал', 'плесо', 'яруга', 'грива',
    'падь', 'косогор', 'исток', 'лукоморье', 'взгорье', 'согра', 'пойма'];

  function randomSeed() {
    var r = new RNG((Date.now() ^ (Math.random() * 0xffffffff)) >>> 0);
    return r.pick(ADJ) + '-' + r.pick(NOUN) + '-' + r.int(100, 999);
  }

  global.RNG = RNG;
  global.hashString = hashString;
  global.randomSeed = randomSeed;
})(typeof window !== 'undefined' ? window : globalThis);
