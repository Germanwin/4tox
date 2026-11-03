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

  function mulberry32(a) {
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function RNG(seed) {
    this.seed = (typeof seed === 'number') ? (seed >>> 0) : hashString(seed);
    this._next = mulberry32(this.seed);
  }

  RNG.prototype.next = function () { return this._next(); };
  RNG.prototype.range = function (a, b) { return a + (b - a) * this._next(); };
  RNG.prototype.int = function (a, b) { return a + Math.floor(this._next() * (b - a + 1)); };
  RNG.prototype.chance = function (p) { return this._next() < p; };
  RNG.prototype.pick = function (arr) { return arr[Math.min(arr.length - 1, Math.floor(this._next() * arr.length))]; };
  RNG.prototype.sign = function () { return this._next() < 0.5 ? -1 : 1; };

  RNG.prototype.weighted = function (weights) {
    var total = 0, i;
    for (i = 0; i < weights.length; i++) total += weights[i];
    var r = this._next() * total;
    for (i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r <= 0) return i;
    }
    return weights.length - 1;
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
