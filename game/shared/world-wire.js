/* world-wire.js — статический мир один раз на матч, компактным двоичным кадром.

   Зачем. Браузерный клиент генерирует остров из сида сам и сверяет
   worldgenHash. Godot-клиент генерировать не должен: перенос шума бит-в-бит —
   это ровно та ловушка, на которой прошлый порт получил другие острова.
   Поэтому сервер один раз отдаёт тайлы, маску суши, dist-поля и объекты
   природы, а клиент только рисует.

   Формат WLD1, всё little-endian:
     u32 magic, u8 version, u16 width, u16 height, u16 islandSize,
     u16 seedLen + seed, u8 hashLen + hash,
     tile[n], isLand[n], distLand u16[n] (×100), distWater u16[n] (×100),
     u32 objectCount,
     объект: u8 kind, u8 variant, u16 x×100, u16 y×100, u16 scale×1000,
             u16 phase×1000, u16 id

   Кодек общий для Node и тестов; правила игры он не знает. */
(function (global) {
  'use strict';

  var MAGIC = 0x31444C57;   // "WLD1"
  var VERSION = 1;

  var KIND = { tree: 0, bush: 1, tuft: 2, flower: 3, stone: 4, reed: 5 };
  var KIND_NAME = ['tree', 'bush', 'tuft', 'flower', 'stone', 'reed'];
  var VARIANT = {
    oak: 1, pine: 2, birch: 3, autumn: 4,
    pebble: 5, boulder: 6, rock: 7, iron: 8, salt: 9,
    f1: 10, f2: 11, f3: 12
  };
  var VARIANT_NAME = [null, 'oak', 'pine', 'birch', 'autumn', 'pebble', 'boulder',
    'rock', 'iron', 'salt', 'f1', 'f2', 'f3'];

  function clampInt(v, lo, hi) {
    v = Math.round(Number(v) || 0);
    return v < lo ? lo : (v > hi ? hi : v);
  }

  function pack(world) {
    var n = world.width * world.height;
    var seed = utf8(world.seed || '');
    var hash = utf8(world.hash || world._worldgenHash || '');
    var objs = world.objects || [];
    var size = 4 + 1 + 2 + 2 + 2 + 2 + seed.length + 1 + hash.length + n + n + n * 4 + 4 + objs.length * 12;
    var buf = new Uint8Array(size);
    var dv = new DataView(buf.buffer);
    var off = 0;
    function u8(v) { buf[off++] = v & 255; }
    function u16(v) { dv.setUint16(off, v & 65535, true); off += 2; }
    function u32(v) { dv.setUint32(off, v >>> 0, true); off += 4; }
    u32(MAGIC); u8(VERSION);
    u16(world.width); u16(world.height); u16(world.islandSize || world.width);
    u16(seed.length);
    for (var i = 0; i < seed.length; i++) u8(seed[i]);
    u8(hash.length);
    for (i = 0; i < hash.length; i++) u8(hash[i]);
    for (i = 0; i < n; i++) u8(world.tile[i] || 0);
    for (i = 0; i < n; i++) u8(world.isLand[i] ? 1 : 0);
    for (i = 0; i < n; i++) u16(clampInt(world.distLand[i] * 100, 0, 65535));
    for (i = 0; i < n; i++) u16(clampInt(world.distWater[i] * 100, 0, 65535));
    u32(objs.length);
    for (i = 0; i < objs.length; i++) {
      var o = objs[i];
      u8(KIND[o.kind] === undefined ? 255 : KIND[o.kind]);
      u8(o.variant && VARIANT[o.variant] !== undefined ? VARIANT[o.variant] : 0);
      u16(clampInt(o.x * 100, 0, 65535));
      u16(clampInt(o.y * 100, 0, 65535));
      u16(clampInt((o.scale || 1) * 1000, 0, 65535));
      u16(clampInt((o.phase || 0) * 1000, 0, 65535));
      u16(clampInt(o.id || 0, 0, 65535));
    }
    return buf.subarray(0, off);
  }

  function unpack(bytes) {
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var off = 0;
    function u8() { return bytes[off++]; }
    function u16() { var v = dv.getUint16(off, true); off += 2; return v; }
    function u32() { var v = dv.getUint32(off, true); off += 4; return v; }
    if (u32() !== MAGIC) throw new Error('world: не WLD1');
    if (u8() !== VERSION) throw new Error('world: версия');
    var width = u16();
    var height = u16();
    var islandSize = u16();
    var seedLen = u16();
    var seed = utf8dec(bytes.subarray(off, off + seedLen));
    off += seedLen;
    var hashLen = u8();
    var hash = utf8dec(bytes.subarray(off, off + hashLen));
    off += hashLen;
    var n = width * height;
    var tile = bytes.subarray(off, off + n); off += n;
    var isLand = bytes.subarray(off, off + n); off += n;
    var distLand = new Float32Array(n);
    for (var i = 0; i < n; i++) distLand[i] = u16() / 100;
    var distWater = new Float32Array(n);
    for (i = 0; i < n; i++) distWater[i] = u16() / 100;
    var count = u32();
    var objects = [];
    for (i = 0; i < count; i++) {
      var kind = KIND_NAME[u8()];
      var variant = VARIANT_NAME[u8()] || null;
      objects.push({
        kind: kind, variant: variant,
        x: u16() / 100, y: u16() / 100,
        scale: u16() / 1000, phase: u16() / 1000,
        id: u16()
      });
    }
    if (off !== bytes.length) throw new Error('world: лишние байты');
    return {
      width: width, height: height, islandSize: islandSize,
      seed: seed, hash: hash,
      tile: tile, isLand: isLand, distLand: distLand, distWater: distWater,
      objects: objects
    };
  }

  function utf8(s) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(String(s));
    return new Uint8Array(Buffer.from(String(s), 'utf8'));
  }
  function utf8dec(b) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(b);
    return Buffer.from(b).toString('utf8');
  }

  var api = { MAGIC: MAGIC, VERSION: VERSION, pack: pack, unpack: unpack };
  global.WorldWire = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
