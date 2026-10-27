/* checkpoint.js — ПОЛНЫЙ codec состояния симуляции для сохранения.

   Это не сетевой снимок. Снимок — представление (его можно потерять), а
   checkpoint — продолжение мира: RNG, таймеры, пути, груз, очередь навигации,
   ссылки и граница команд. Поэтому здесь сохраняется ВЕСЬ граф SimState, а не
   короткий whitelist полей: новое игровое поле не должно исчезать из
   сохранения только потому, что его забыли дописать в список.

   Формат (checkpointSchema:1):
     { checkpointSchema: 1, root: {$ref:0}, nodes: [...], meta: {...} }

   Узел — обычные данные: object/array/Map/Set/typed array/DataView/
   ArrayBuffer/RNG. Ссылки — {$ref:id}; undefined — {$u:1}. Циклы и общие
   ссылки сохраняются: сначала выделяются все узлы, потом восстанавливаются
   ссылки на них, а не на копии.

   Функции, DOM, Canvas, Image, Promise и прочие не-данные — ЯВНАЯ ошибка с
   путём поля. Заменять их null или молча выкидывать запрещено: иначе
   восстановленный мир отличался бы от сохранённого, а проверка этого бы не
   видела. */
(function (global) {
  'use strict';

  var SCHEMA = 1;
  var TAG_UNDEF = '$u';
  var TAG_REF = '$ref';

  function fail(code, path, extra) {
    var e = new Error(code + (path ? ' at ' + path : '') +
      (extra ? ': ' + extra : ''));
    e.code = code;
    e.path = path || '';
    return e;
  }

  function isPlainObject(v) {
    if (!v || typeof v !== 'object') return false;
    var p = Object.getPrototypeOf(v);
    return p === Object.prototype || p === null;
  }

  function isArrayBuffer(v) {
    return typeof ArrayBuffer !== 'undefined' && v instanceof ArrayBuffer;
  }

  function isView(v) {
    return typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(v);
  }

  function viewName(v) {
    if (!isView(v)) return '';
    if (v instanceof DataView) return 'DataView';
    return v.constructor && v.constructor.name ? v.constructor.name : 'View';
  }

  function typedByName(name, n) {
    if (name === 'DataView') return null;
    var C = global[name];
    if (!C) throw fail('unsupported_typed_array', '', name);
    return C;
  }

  function bytesOf(v) {
    if (isArrayBuffer(v)) return new Uint8Array(v);
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  }

  function b64encode(bytes) {
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
    }
    var s = '', i;
    for (i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return global.btoa(s);
  }

  function b64decode(str) {
    if (typeof Buffer !== 'undefined') {
      var buf = Buffer.from(String(str), 'base64');
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    }
    var raw = global.atob(String(str));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function isRNG(v) {
    return !!(v && typeof v === 'object' &&
      typeof v.getState === 'function' && typeof v.next === 'function' &&
      (v.constructor === global.RNG ||
        (v.constructor && typeof v.constructor.fromState === 'function')));
  }

  function encodeNumber(n, path) {
    if (typeof n !== 'number' || !isFinite(n)) throw fail('non_finite_number', path);
    return n === 0 && 1 / n < 0 ? 0 : n;   // -0 неотличим от 0 в игре
  }

  function encode(state, options) {
    options = options || {};
    var nodes = [];
    var seen = new Map();
    var stack = [];

    function enc(value, path) {
      if (value === null) return null;
      var t = typeof value;
      if (t === 'undefined') {
        var u = {}; u[TAG_UNDEF] = 1; return u;
      }
      if (t === 'boolean' || t === 'string') return value;
      if (t === 'number') return encodeNumber(value, path);
      if (t === 'function') throw fail('function_in_state', path);
      if (t !== 'object') throw fail('unsupported_primitive', path, t);
      if (seen.has(value)) {
        var r = {}; r[TAG_REF] = seen.get(value); return r;
      }
      if (isRNG(value)) {
        var idR = nodes.length;
        seen.set(value, idR);
        nodes.push({ k: 'rng', v: value.getState() });
        return { $ref: idR };
      }
      if (isArrayBuffer(value)) {
        var idB = nodes.length;
        seen.set(value, idB);
        nodes.push({ k: 'ab', b: b64encode(bytesOf(value)) });
        return { $ref: idB };
      }
      if (isView(value)) {
        var idV = nodes.length;
        seen.set(value, idV);
        var name = viewName(value);
        /* Узел view занимает СВОЙ id ДО обхода буфера: иначе enc(buffer)
           добавит узел раньше, и ссылка view укажет на чужой узел. */
        var nodeV = {
          k: 'tv', c: name, off: value.byteOffset, len: value.byteLength, buf: null
        };
        nodes.push(nodeV);
        nodeV.buf = enc(value.buffer, path + '.buffer');
        return { $ref: idV };
      }
      if (Array.isArray(value)) {
        var idA = nodes.length;
        seen.set(value, idA);
        stack.push(path);
        var arr = new Array(value.length);
        var nodeA = { k: 'a', v: arr };
        nodes.push(nodeA);
        for (var i = 0; i < value.length; i++) {
          arr[i] = enc(value[i], path + '[' + i + ']');
        }
        stack.pop();
        return { $ref: idA };
      }
      if (value instanceof Map) {
        var idM = nodes.length;
        seen.set(value, idM);
        stack.push(path);
        var entries = [];
        var nodeM = { k: 'm', v: entries };
        nodes.push(nodeM);
        var mi = 0;
        value.forEach(function (val, key) {
          entries.push([
            enc(key, path + '.<key ' + mi + '>'),
            enc(val, path + '.<value ' + mi + '>')
          ]);
          mi++;
        });
        stack.pop();
        return { $ref: idM };
      }
      if (value instanceof Set) {
        var idS = nodes.length;
        seen.set(value, idS);
        stack.push(path);
        var values = [];
        var nodeS = { k: 's', v: values };
        nodes.push(nodeS);
        var si = 0;
        value.forEach(function (val) {
          values.push(enc(val, path + '.<set ' + si + '>'));
          si++;
        });
        stack.pop();
        return { $ref: idS };
      }
      if (!isPlainObject(value)) {
        var cname = (value && value.constructor && value.constructor.name) || 'Object';
        throw fail('unsupported_instance', path, cname);
      }
      var idO = nodes.length;
      seen.set(value, idO);
      stack.push(path);
      var obj = {};
      var nodeO = { k: 'o', v: obj };
      nodes.push(nodeO);
      var keys = Object.keys(value);
      for (var k = 0; k < keys.length; k++) {
        obj[keys[k]] = enc(value[keys[k]], path + '.' + keys[k]);
      }
      stack.pop();
      return { $ref: idO };
    }

    var root = enc(state, 'root');
    var meta = {
      checkpointSchema: SCHEMA,
      buildHash: options.buildHash || null,
      configHash: options.configHash ||
        (global.GameplayConfig && global.GameplayConfig.hash) || null,
      worldgenHash: options.worldgenHash || null
    };
    return { checkpointSchema: SCHEMA, root: root, nodes: nodes, meta: meta };
  }

  function validate(dto) {
    if (!dto || typeof dto !== 'object') throw fail('checkpoint_not_object', '');
    if (dto.checkpointSchema !== SCHEMA) throw fail('checkpoint_schema', '', String(dto.checkpointSchema));
    if (!Array.isArray(dto.nodes)) throw fail('checkpoint_nodes_missing', '');
    if (!dto.root || typeof dto.root !== 'object') throw fail('checkpoint_root_missing', 'root');
    var n = dto.nodes.length;
    function checkRef(v, path) {
      if (v && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, TAG_REF)) {
        var id = v[TAG_REF];
        if (!Number.isInteger(id) || id < 0 || id >= n) throw fail('bad_ref', path, String(id));
      }
    }
    for (var i = 0; i < n; i++) {
      var node = dto.nodes[i];
      if (!node || typeof node !== 'object') throw fail('bad_node', 'nodes[' + i + ']');
      var k = node.k;
      if (k === 'o') {
        if (!node.v || typeof node.v !== 'object' || Array.isArray(node.v)) throw fail('bad_object_node', 'nodes[' + i + ']');
        for (var key in node.v) if (Object.prototype.hasOwnProperty.call(node.v, key)) {
          checkRef(node.v[key], 'nodes[' + i + '].' + key);
        }
      } else if (k === 'a') {
        if (!Array.isArray(node.v)) throw fail('bad_array_node', 'nodes[' + i + ']');
        for (var ai = 0; ai < node.v.length; ai++) checkRef(node.v[ai], 'nodes[' + i + '][' + ai + ']');
      } else if (k === 'm' || k === 's') {
        if (!Array.isArray(node.v)) throw fail('bad_collection_node', 'nodes[' + i + ']');
        for (var mi = 0; mi < node.v.length; mi++) {
          var item = node.v[mi];
          if (k === 'm') {
            if (!Array.isArray(item) || item.length !== 2) throw fail('bad_map_entry', 'nodes[' + i + '][' + mi + ']');
            checkRef(item[0], 'nodes[' + i + '][' + mi + '][0]');
            checkRef(item[1], 'nodes[' + i + '][' + mi + '][1]');
          } else checkRef(item, 'nodes[' + i + '][' + mi + ']');
        }
      } else if (k === 'tv') {
        if (!node.c || !Number.isInteger(node.off) || node.off < 0 ||
            !Number.isInteger(node.len) || node.len < 0) {
          throw fail('bad_typed_node', 'nodes[' + i + ']');
        }
        checkRef(node.buf, 'nodes[' + i + '].buf');
        if (node.buf && Object.prototype.hasOwnProperty.call(node.buf, TAG_REF)) {
          var bid = node.buf[TAG_REF];
          if (bid < 0 || bid >= n) throw fail('bad_ref', 'nodes[' + i + '].buf');
        }
      } else if (k === 'ab') {
        if (typeof node.b !== 'string') throw fail('bad_buffer_node', 'nodes[' + i + ']');
      } else if (k === 'rng') {
        if (!node.v || !Number.isInteger(node.v.seed) || !Number.isInteger(node.v.state)) {
          throw fail('bad_rng_node', 'nodes[' + i + ']');
        }
      } else throw fail('unknown_node_kind', 'nodes[' + i + ']', String(k));
    }
    checkRef(dto.root, 'root');
    return true;
  }

  function decode(dto) {
    validate(dto);
    var nodes = dto.nodes;
    var out = new Array(nodes.length);
    var i;
    /* Сначала выделяем все узлы: ссылка может указывать вперёд. */
    for (i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (node.k === 'o') out[i] = {};
      else if (node.k === 'a') out[i] = new Array(node.v.length);
      else if (node.k === 'm') out[i] = new Map();
      else if (node.k === 's') out[i] = new Set();
      else if (node.k === 'rng') {
        if (!global.RNG || typeof global.RNG.fromState !== 'function') {
          throw fail('rng_from_state_missing', 'nodes[' + i + ']');
        }
        out[i] = global.RNG.fromState(node.v);
      } else if (node.k === 'ab') {
        var abBytes = b64decode(node.b);
        out[i] = abBytes.buffer.slice(abBytes.byteOffset, abBytes.byteOffset + abBytes.byteLength);
      } else if (node.k === 'tv') {
        /* Буфер выделяется в этом же первом проходе; views — во втором,
           после того как ссылки на буферы уже стоят. */
        out[i] = null;
      }
    }
    function dec(v, path) {
      if (v === null) return null;
      if (typeof v === 'boolean' || typeof v === 'string') return v;
      if (typeof v === 'number') {
        if (!isFinite(v)) throw fail('non_finite_number', path);
        return v;
      }
      if (Array.isArray(v)) throw fail('unexpected_array_value', path);
      if (typeof v !== 'object') throw fail('bad_encoded_value', path);
      if (Object.prototype.hasOwnProperty.call(v, TAG_UNDEF)) return undefined;
      if (Object.prototype.hasOwnProperty.call(v, TAG_REF)) {
        var id = v[TAG_REF];
        if (!Number.isInteger(id) || id < 0 || id >= out.length) throw fail('bad_ref', path, String(id));
        return out[id];
      }
      throw fail('bad_encoded_value', path);
    }
    /* Второй проход: views. Буферы уже выделены первым проходом, поэтому
       порядок узлов в DTO не важен. */
    for (i = 0; i < nodes.length; i++) {
      var ndv = nodes[i];
      if (ndv.k !== 'tv') continue;
      var bufId = ndv.buf && ndv.buf[TAG_REF];
      var ab = out[bufId];
      if (!ab) throw fail('typed_buffer_missing', 'nodes[' + i + ']');
      if (ndv.c === 'DataView') {
        out[i] = new DataView(ab, ndv.off, ndv.len);
      } else {
        var C = typedByName(ndv.c, ndv.len);
        if (!C || C.BYTES_PER_ELEMENT === undefined) throw fail('unsupported_typed_array', '', ndv.c);
        out[i] = new C(ab, ndv.off, ndv.len / C.BYTES_PER_ELEMENT);
      }
    }
    /* Третий проход: содержимое объектов/массивов/Map/Set. Views к этому
       моменту уже стоят в out, поэтому ссылка из объекта не получит null. */
    for (i = 0; i < nodes.length; i++) {
      var nd = nodes[i];
      if (nd.k === 'o') {
        for (var key in nd.v) if (Object.prototype.hasOwnProperty.call(nd.v, key)) {
          out[i][key] = dec(nd.v[key], 'nodes[' + i + '].' + key);
        }
      } else if (nd.k === 'a') {
        for (var ai = 0; ai < nd.v.length; ai++) out[i][ai] = dec(nd.v[ai], 'nodes[' + i + '][' + ai + ']');
      } else if (nd.k === 'm') {
        for (var mi = 0; mi < nd.v.length; mi++) {
          out[i].set(dec(nd.v[mi][0], 'nodes[' + i + '].k' + mi),
            dec(nd.v[mi][1], 'nodes[' + i + '].v' + mi));
        }
      } else if (nd.k === 's') {
        for (var si = 0; si < nd.v.length; si++) out[i].add(dec(nd.v[si], 'nodes[' + i + '].s' + si));
      }
    }
    return dec(dto.root, 'root');
  }

  /* Канонический хеш — для тестов «до/после восстановления одинаково».
     Порядок ключей plain object не влияет, порядок массивов влияет; ссылки
     выводятся как @id первого вхождения. Map/Set сортируются по
     каноническому представлению элементов, чтобы вставка в другом порядке
     не меняла хеш. */
  function canonical(simState) {
    var seen = new Map();
    var nextId = 1;
    function key(v, path) {
      if (v === null) return 'null';
      var t = typeof v;
      if (t === 'undefined') return 'u';
      if (t === 'boolean') return v ? 't' : 'f';
      if (t === 'string') return 's' + JSON.stringify(v);
      if (t === 'number') {
        if (!isFinite(v)) throw fail('non_finite_number', path);
        return 'n' + (Object.is(v, -0) ? '0' : String(v));
      }
      if (t === 'function') throw fail('function_in_state', path);
      if (t !== 'object') return '?' + t;
      if (seen.has(v)) return '@' + seen.get(v);
      var id = nextId++;
      seen.set(v, id);
      if (isRNG(v)) return 'r' + id + '(' + v.getState().seed + ',' + v.getState().state + ')';
      if (isArrayBuffer(v)) return 'ab' + id + ':' + b64encode(bytesOf(v));
      if (isView(v)) return 'tv' + id + ':' + viewName(v) + ':' + b64encode(bytesOf(v));
      if (Array.isArray(v)) {
        var arr = [];
        for (var i = 0; i < v.length; i++) arr.push(key(v[i], path + '[' + i + ']'));
        return 'a' + id + '[' + arr.join(',') + ']';
      }
      if (v instanceof Map) {
        var entries = [];
        v.forEach(function (val, k) {
          entries.push(key(k, path + '.<k>') + '=>' + key(val, path + '.<v>'));
        });
        entries.sort();
        return 'm' + id + '{' + entries.join(',') + '}';
      }
      if (v instanceof Set) {
        var vals = [];
        v.forEach(function (val) { vals.push(key(val, path + '.<s>')); });
        vals.sort();
        return 's' + id + '{' + vals.join(',') + '}';
      }
      if (!isPlainObject(v)) {
        throw fail('unsupported_instance', path,
          (v && v.constructor && v.constructor.name) || 'Object');
      }
      var keys = Object.keys(v).sort();
      var parts = [];
      for (var k = 0; k < keys.length; k++) {
        parts.push(JSON.stringify(keys[k]) + ':' + key(v[keys[k]], path + '.' + keys[k]));
      }
      return 'o' + id + '{' + parts.join(',') + '}';
    }
    return key(simState, 'root');
  }

  function canonicalHash(simState) {
    var s = canonical(simState);
    var h1 = 2166136261 >>> 0, h2 = 0x9e3779b9 >>> 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      h1 ^= c; h1 = Math.imul(h1, 16777619);
      h2 = Math.imul(h2 ^ c, 2246822519);
    }
    return ('00000000' + (h1 >>> 0).toString(16)).slice(-8) +
      ('00000000' + (h2 >>> 0).toString(16)).slice(-8);
  }

  global.Checkpoint = {
    SCHEMA: SCHEMA,
    encode: encode,
    decode: decode,
    validate: validate,
    canonical: canonical,
    canonicalHash: canonicalHash
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.Checkpoint;
})(typeof window !== 'undefined' ? window : globalThis);
