/* stand.js — стенд моделей 4tox.
 *
 * Две половины, и обе про одно: слева 3D-модель как она есть (GLB из art/),
 * снизу — кадры атласа, которые игра реально рисует. Между ними — камера
 * рендера спрайтов: азимут 45°, подъём 35.2644°, ортография. Поэтому «4
 * поворота» в стенде и четыре кадра атласа — это одно и то же, и расхождение
 * видно глазом.
 *
 * Ничего не грузит из сети: байты GLB лежат в data/meshes.js в base64, картинки
 * атласов берутся по относительному пути. Поэтому страница работает и по
 * file://, двойным кликом, — как index.html самой игры.
 */
(function () {
  'use strict';

  var CAT = window.MODEL_STAND_CATALOG;
  var MESHES = window.MODEL_STAND_MESHES || {};
  var BASE = '../../../';                       // стенд лежит в art/tools/model-stand/
  var MODEL_BY_ID = {}, ATLAS_BY_NAME = {};
  var params = new URLSearchParams(location.search);

  CAT.models.forEach(function (m) { MODEL_BY_ID[m.id] = m; });
  CAT.atlases.forEach(function (a) { ATLAS_BY_NAME[a.name] = a; });

  // Открываемся на ратуше варианта C: это та модель, которую ставит игра, —
  // первое, что должен увидеть человек. Нет её — берём первую в списке.
  function defaultModelId() {
    var townhall = CAT.models.filter(function (m) {
      return /townhall_c$/.test(m.id);
    })[0];
    return (townhall || CAT.models[0]).id;
  }

  var state = {
    filter: params.get('filter') || 'all',
    query: '',
    modelId: params.get('m') || defaultModelId(),
    atlasName: params.get('atlas') || null,
    wire: params.get('wire') === '1',
    grid: params.get('grid') !== '0',
    box: params.get('box') === '1',
    spin: params.get('spin') === '1',
    iso: params.get('iso') === '1',
    quad: params.get('quad') === '1',
    camMode: null,
    sheet: params.get('sheet') === '1',
    zoom: null,
    anim: null,
    rot: Number(params.get('rot') || 0),
    playing: false
  };

  if (!MODEL_BY_ID[state.modelId]) state.modelId = defaultModelId();

  // Сверка данных на старте. Каталог и байты моделей пишутся двумя файлами;
  // если браузер подхватил один свежий, а другой нет (или сборка прервалась),
  // список покажет модели, которых нечем нарисовать. Молчать об этом нельзя:
  // человек видит пустое окно и думает, что модели нет.
  var DATA_MISSING = CAT.models.filter(function (m) {
    return !MESHES[m.meshKey];
  });

  /* ------------------------------ мелочи -------------------------------- */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function btn(label, cls, onClick) {
    var b = el('button', cls || 'chip', label);
    b.type = 'button';
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }

  function fmt(n, digits) {
    return Number(n).toLocaleString('ru-RU', {
      minimumFractionDigits: digits || 0, maximumFractionDigits: digits || 0
    });
  }

  function kb(bytes) { return (bytes / 1024).toFixed(bytes < 10240 ? 1 : 0) + ' КБ'; }

  function plural(n, one, few, many) {
    var m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
  }

  function pathLink(rel, note) {
    var li = el('li');
    var a = el('a', null, rel);
    a.href = BASE + rel;
    a.title = 'открыть ' + rel;
    li.appendChild(a);
    if (note) li.appendChild(el('span', 'pk', ' — ' + note));
    return li;
  }

  function badge(text, cls) { return el('span', 'badge ' + (cls || ''), text); }

  function modelBadge(m) {
    if (m.inGame) return badge('в игре', 'game');
    if (m.atlas && ATLAS_BY_NAME[m.atlas]) return badge('собран, не подключён', 'ready');
    return badge('не в игре', 'out');
  }

  /* ------------------------- 3D-вьюпорт (three.js) ----------------------- */

  // В репозитории три камеры рендера, и это не описка: см. RULES в
  // tools/build_catalog.py и art/characters/villager/README.md §2. Стенд
  // показывает модель её собственной камерой, а переключатель рядом.
  // Оси: Blender (x, y, z) → glTF/three (x, z, −y).
  function toThree(v) { return new THREE.Vector3(v[0], v[2], -v[1]); }

  // Отражение модели, когда камера проекта — левша (см. `mirror` в каталоге).
  // Ось отражения — экранное «вправо» камеры, поэтому в осях three это
  // (x, y, z) → (−z, y, −x): точка с координатой x уезжает на −z и наоборот.
  var MIRROR_M = new THREE.Matrix4().set(
    0, 0, -1, 0,
    0, 1, 0, 0,
    -1, 0, 0, 0,
    0, 0, 0, 1);

  function cameraDef() {
    var m = MODEL_BY_ID[state.modelId];
    var mode = state.camMode || (m && m.camera) || CAT.gameCanon;
    var def = CAT.cameras[mode] || CAT.cameras[CAT.gameCanon];
    return { id: mode, title: def.title, eye: def.eye, sun: def.sun,
             source: def.source, mirror: !!def.mirror };
  }

  function eyeDir() { return toThree(cameraDef().eye).normalize(); }

  // Поворот, запечённый в GLB при выгрузке (у ратуши и хижины 180°: экспортёр
  // разворачивает геометрию, чтобы дверь смотрела в glTF +Z). Кадры атласа
  // рисовались БЕЗ него, поэтому «4 поворота» вычитают его — иначе квадрант 0°
  // показывал бы кадр 180°.
  function frameOffset() {
    var m = MODEL_BY_ID[state.modelId];
    return (m && m.exportRot) || 0;
  }

  var canvas = document.getElementById('view');
  var wrap = document.getElementById('viewWrap');
  var renderer = new THREE.WebGLRenderer({
    canvas: canvas, antialias: true, preserveDrawingBuffer: true
  });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputEncoding = THREE.sRGBEncoding;

  var scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d1a22);

  var persp = new THREE.PerspectiveCamera(32, 1, 0.01, 800);
  var ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -400, 800);
  persp.up.set(0, 1, 0);
  ortho.up.set(0, 1, 0);

  var controls = new THREE.OrbitControls(persp, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.09;
  controls.rotateSpeed = 0.85;
  controls.zoomSpeed = 0.9;
  controls.target.set(0, 0.5, 0);

  // Свет подобран замером, а не на глаз: tools/shot.js считает средний цвет
  // модели во вьюпорте и средний цвет её же кадра атласа — они должны сойтись.
  // Плоские фасеты и тёмный контур спрайта дают низкое среднее, поэтому
  // суммарная освещённость здесь намеренно ниже «красивой».
  scene.add(new THREE.HemisphereLight(0xa8b6c4, 0x2b333c, 0.34));
  var sun = new THREE.DirectionalLight(0xfff4e2, 0.95);
  scene.add(sun);
  var rim = new THREE.DirectionalLight(0x9ec7ff, 0.12);
  rim.position.set(2.2, 1.4, 2.6);
  scene.add(rim);

  function placeSun() {
    var v = toThree(cameraDef().sun).normalize();
    if (cameraDef().mirror) v.applyMatrix4(MIRROR_M);
    sun.position.copy(v.multiplyScalar(14));
  }

  // root носит поворот кадра (угол атласа минус поворот выгрузки), внутри —
  // отражение, если камера проекта левша, и уже в нём лежит модель.
  var root = new THREE.Group();
  scene.add(root);
  var mirrorGroup = new THREE.Group();
  mirrorGroup.matrixAutoUpdate = false;
  root.add(mirrorGroup);

  var grid = null, boxHelper = null, axes = null;
  var current = null;                               // { meshKey, object, box }
  var loading = false;
  var cache = {};
  var size = { w: 1, h: 1 };
  var radius = 1;

  var loader = new THREE.GLTFLoader();

  function b64buf(b64) {
    var bin = atob(b64), len = bin.length, buf = new Uint8Array(len);
    for (var i = 0; i < len; i++) buf[i] = bin.charCodeAt(i);
    return buf.buffer;
  }

  function clearHelpers() {
    [grid, boxHelper, axes].forEach(function (h) {
      if (h) { scene.remove(h); h.geometry.dispose(); }
    });
    grid = boxHelper = axes = null;
  }

  function makeHelpers(box) {
    clearHelpers();
    var s = box.getSize(new THREE.Vector3());
    var span = Math.max(2, Math.ceil(Math.max(s.x, s.z, s.y)) + 1);
    // Клетка сетки — ровно 1 юнит модели, то есть 1 клетка карты в игре.
    grid = new THREE.GridHelper(span, span, 0x2e5560, 0x1d3a44);
    grid.position.set(box.getCenter(new THREE.Vector3()).x, box.min.y, box.getCenter(new THREE.Vector3()).z);
    grid.visible = state.grid;
    scene.add(grid);

    axes = new THREE.AxesHelper(Math.max(0.5, span * 0.12));
    axes.position.copy(grid.position);
    scene.add(axes);

    boxHelper = new THREE.Box3Helper(box, 0x46b47c);
    boxHelper.visible = state.box;
    scene.add(boxHelper);
  }

  function applyMaterials(object) {
    object.traverse(function (o) {
      if (!o.isMesh) return;
      var mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach(function (m) {
        m.wireframe = state.wire;
        if (m.side !== undefined) m.side = THREE.DoubleSide;
      });
    });
  }

  function fit(object) {
    var box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) box.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(1, 1, 1));
    var s = box.getSize(new THREE.Vector3());
    var c = box.getCenter(new THREE.Vector3());
    var dir = eyeDir();
    radius = Math.max(s.x, s.y, s.z) * 0.5;
    var dist = Math.max(0.5, radius / Math.tan(persp.fov * Math.PI / 360) * 1.34);
    persp.position.copy(dir).multiplyScalar(dist).add(c);
    persp.near = Math.max(0.005, dist * 0.02);
    persp.far = dist * 12 + 50;
    persp.updateProjectionMatrix();
    ortho.position.copy(dir).multiplyScalar(dist * 2).add(c);
    ortho.zoom = 1;
    controls.object = persp;
    controls.target.copy(c);
    controls.update();
    return box;
  }

  function setOrthoFrustum() {
    var box = current ? current.box : new THREE.Box3();
    var c = box.getCenter(new THREE.Vector3());
    var s = box.getSize(new THREE.Vector3());
    // вертикальный охват — по высоте модели, но не меньше половины ширины
    var h = Math.max(s.y, (s.x + s.z) * 0.35, 0.4) * 1.9;
    var aspect = size.w / Math.max(1, size.h);
    ortho.left = -h * aspect / 2;
    ortho.right = h * aspect / 2;
    ortho.top = h / 2;
    ortho.bottom = -h / 2;
    ortho.position.copy(eyeDir()).multiplyScalar(Math.max(10, radius * 8)).add(c);
    ortho.lookAt(c);
    ortho.near = -200;
    ortho.far = 600;
    ortho.updateProjectionMatrix();
  }

  function activeCamera() { return state.iso ? ortho : persp; }

  function resize() {
    var w = Math.max(1, wrap.clientWidth), h = Math.max(1, wrap.clientHeight);
    size.w = w; size.h = h;
    renderer.setSize(w, h, false);
    persp.aspect = w / h;
    persp.updateProjectionMatrix();
    setOrthoFrustum();
  }

  function draw() {
    if (state.quad) {
      var angles = [0, 90, 180, 270];
      var vw = Math.floor(size.w / 2), vh = Math.floor(size.h / 2);
      renderer.setScissorTest(true);
      for (var i = 0; i < 4; i++) {
        var x = (i % 2) * vw;
        var y = (i < 2) ? vh : 0;                    // 0 — верх слева: WebGL считает снизу
        renderer.setViewport(x, y, vw, vh);
        renderer.setScissor(x, y, vw, vh);
        root.rotation.y = (angles[i] - frameOffset()) * Math.PI / 180;
        renderer.render(scene, ortho);
      }
      root.rotation.y = Math.PI * 0;
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, size.w, size.h);
    } else {
      renderer.render(scene, activeCamera());
    }
  }

  function loop() {
    requestAnimationFrame(loop);
    if (state.spin && !state.quad) root.rotation.y += 0.0075;
    else if (state.spin && state.quad) root.rotation.y = -frameOffset() * Math.PI / 180;
    if (!state.iso) controls.update();
    draw();
  }

  function showModel(model, done) {
    if (current && current.meshKey === model.meshKey) {
      current.object.visible = true;
      applyMaterials(current.object);
      if (done) done(current);
      return;
    }
    function mount(gltf) {
      mirrorGroup.clear();
      var object = gltf.scene || gltf.scenes[0];
      object.rotation.set(0, 0, 0);
      mirrorGroup.add(object);
      mirrorGroup.matrix.copy(model.mirror ? MIRROR_M : new THREE.Matrix4());
      mirrorGroup.matrixWorldNeedsUpdate = true;
      root.rotation.y = -frameOffset() * Math.PI / 180;
      current = { meshKey: model.meshKey, object: object };
      placeSun();
      current.box = fit(object);
      makeHelpers(current.box);
      applyMaterials(object);
      setOrthoFrustum();
      loading = false;
      if (done) done(current);
    }
    if (cache[model.meshKey]) { loading = true; mount(cache[model.meshKey]); return; }
    var b64 = MESHES[model.meshKey];
    if (!b64) {
      note('НЕТ БАЙТОВ: модель есть в каталоге, но её нет в data/meshes.js. ' +
        'Пересоберите каталог: python3 art/tools/model-stand/tools/build_catalog.py');
      return;
    }
    loading = true;
    loader.parse(b64buf(b64), '', function (gltf) {
      cache[model.meshKey] = gltf;
      mount(gltf);
    }, function (err) {
      loading = false;
      note('GLB не разобрался: ' + (err && err.message ? err.message : err));
    });
  }

  function note(text) {
    document.getElementById('viewNote').textContent = text || '';
  }

  // Строка под вьюпортом: что показано и откуда смотрит камера.
  function refreshNote() {
    if (!current) return;
    var m = MODEL_BY_ID[current.meshKey];
    var cam = cameraDef();
    var s = current.box.getSize(new THREE.Vector3());
    note(m.title + ' · ' + fmt(m.stats.tris) + ' трис · ' +
      s.toArray().map(function (v) { return v.toFixed(2); }).join(' × ') + ' юнита' +
      ' · клетка сетки = 1 клетка карты' +
      ' · камера: ' + cam.title + (cam.id === CAT.gameCanon ? ' (канон игры)' : ''));
  }

  /* ------------------------------- список ------------------------------- */

  var listBox = document.getElementById('list');

  function visibleModels() {
    var q = state.query.trim().toLowerCase();
    return CAT.models.filter(function (m) {
      if (state.filter === 'atlases') return false;
      if (state.filter === 'game' && !m.inGame) return false;
      if (!q) return true;
      return (m.title + ' ' + m.id + ' ' + m.where + ' ' + m.glb.path)
        .toLowerCase().indexOf(q) >= 0;
    });
  }

  function visibleAtlases() {
    if (state.filter === 'models' || state.filter === 'game') return [];
    var q = state.query.trim().toLowerCase();
    return CAT.atlases.filter(function (a) {
      if (!q) return true;
      return (a.name + ' ' + a.path + ' ' + a.note + ' ' + a.origin)
        .toLowerCase().indexOf(q) >= 0;
    });
  }

  function renderList() {
    listBox.textContent = '';
    var models = visibleModels();
    var atlases = visibleAtlases();
    var byGroup = {};
    models.forEach(function (m) { (byGroup[m.group] = byGroup[m.group] || []).push(m); });

    CAT.groups.forEach(function (g) {
      var items = byGroup[g.id];
      if (!items || !items.length) return;
      listBox.appendChild(el('div', 'grp', g.name + ' · ' + items.length));
      items.forEach(function (m) {
        var b = el('button', 'item' + (m.id === state.modelId ? ' active' : ''));
        b.type = 'button';
        b.dataset.id = m.id;
        b.appendChild(el('span', 'it-title', m.title));
        b.appendChild(el('span', 'it-sub',
          fmt(m.stats.tris) + ' трис · ' + m.stats.bbox.map(function (v) {
            return v.toFixed(2);
          }).join('×') + ' юнита'));
        var row = el('div');
        row.style.marginTop = '3px';
        row.appendChild(modelBadge(m));
        if (!MESHES[m.meshKey]) {
          var nb = badge('нет байтов', 'out');
          nb.title = 'в data/meshes.js нет этой модели — пересоберите каталог';
          row.appendChild(nb);
        }
        b.appendChild(row);
        b.addEventListener('click', function () { select(m.id); });
        listBox.appendChild(b);
      });
    });

    if (atlases.length) {
      listBox.appendChild(el('div', 'grp', 'Атласы игры · ' + atlases.length));
      atlases.forEach(function (a) {
        var b = el('button', 'item' + (a.name === state.atlasName && !state.modelId ? ' active' : ''));
        b.type = 'button';
        b.appendChild(el('span', 'it-title', a.name));
        b.appendChild(el('span', 'it-sub', a.frames.length + ' ' +
          plural(a.frames.length, 'кадр', 'кадра', 'кадров') + ' · ' +
          (a.size ? a.size.join('×') : '?') + ' px'));
        var row = el('div');
        row.style.marginTop = '3px';
        row.appendChild(a.connected ? badge('в игре', 'game') : badge('не подключён', 'ready'));
        if (!a.models.length) {
          var no3d = badge('3D нет', 'out');
          no3d.title = a.origin || 'исходных моделей в репозитории нет';
          row.appendChild(no3d);
        } else {
          row.appendChild(badge(a.models.length + ' ' + plural(a.models.length, 'модель', 'модели', 'моделей'), ''));
        }
        b.appendChild(row);
        b.addEventListener('click', function () { selectAtlas(a.name); });
        listBox.appendChild(b);
      });
    }

    if (!models.length && !atlases.length) {
      listBox.appendChild(el('div', 'empty', 'ничего не нашлось'));
    }
  }

  /* ------------------------------ карточка ------------------------------ */

  var card = document.getElementById('card');

  function kv(rows) {
    var dl = el('dl', 'kv');
    rows.forEach(function (r) {
      if (r[1] == null || r[1] === '') return;
      dl.appendChild(el('dt', null, r[0]));
      dl.appendChild(el('dd', null, r[1]));
    });
    return dl;
  }

  function section(title) { return el('h3', null, title); }

  // Карточка атласа, у которого 3D-модели в репозитории нет (sprites, hero).
  // Говорим прямо, что смотреть можно только спрайты, и почему так вышло.
  function renderAtlasCard(a) {
    if (!a) return;
    card.appendChild(el('h2', null, 'Атлас ' + a.name));
    card.appendChild(el('div', 'id', a.path));
    var tags = el('div');
    tags.style.marginTop = '6px';
    tags.appendChild(a.connected ? badge('в игре', 'game') : badge('не подключён', 'ready'));
    if (!a.models.length) tags.appendChild(badge('3D-модели нет', 'out'));
    card.appendChild(tags);

    card.appendChild(section('Кадры'));
    card.appendChild(kv([
      ['Кадров', fmt(a.frames.length)],
      ['Лист', a.size ? a.size.join(' × ') + ' px' : '—'],
      ['Крупность', a.ppu ? a.ppu + ' ppu' : '—'],
      ['Камера', a.az != null
        ? 'азимут ' + a.az + '°, подъём ' + Number(a.el).toFixed(4) + '°' : '—'],
      ['Анимации', Object.keys(a.anims).length
        ? Object.keys(a.anims).map(function (k) {
            return k + ' ' + a.anims[k].fps + ' fps';
          }).join(', ') : 'нет'],
      ['Подключён', a.pages.length ? a.pages.join(' и ') : 'нигде']
    ]));

    if (!a.models.length) {
      card.appendChild(section('Откуда геометрия'));
      var nn = el('p', 'anote none');
      nn.appendChild(el('b', null, a.origin || 'исходных моделей в репозитории нет'));
      nn.appendChild(el('div', null, 'В стенде по этому атласу видны только ' +
        'спрайты: 3D-исходника нет, восстановить его не из чего. Кадры ниже — ' +
        'это ровно то, что игра рисует на экране.'));
      card.appendChild(nn);
    } else {
      card.appendChild(section('Модели этого атласа'));
      var ul = el('ul', 'paths');
      a.models.forEach(function (mid) {
        var li = el('li');
        var b = el('a', null, MODEL_BY_ID[mid].title);
        b.href = '#';
        b.addEventListener('click', function (e) { e.preventDefault(); select(mid); });
        li.appendChild(b);
        ul.appendChild(li);
      });
      card.appendChild(ul);
    }

    if (a.note) {
      card.appendChild(section('Заметка атласа'));
      card.appendChild(el('p', 'anote', a.note));
    }
  }

  function renderCard() {
    card.textContent = '';
    var m = MODEL_BY_ID[state.modelId];
    if (!m) {
      if (state.atlasName) renderAtlasCard(ATLAS_BY_NAME[state.atlasName]);
      else card.appendChild(el('div', 'empty', 'выбери модель или атлас слева'));
      return;
    }
    var atlas = m.atlas ? ATLAS_BY_NAME[m.atlas] : null;

    var head = el('div');
    head.appendChild(el('h2', null, m.title));
    head.appendChild(el('div', 'id', m.id));
    var tags = el('div');
    tags.style.marginTop = '6px';
    tags.appendChild(modelBadge(m));
    head.appendChild(tags);
    card.appendChild(head);
    card.appendChild(el('p', 'where', m.where));

    card.appendChild(section('Числа'));
    card.appendChild(kv([
      ['Треугольников', fmt(m.stats.tris)],
      ['Вершин', fmt(m.stats.verts)],
      ['Мешей / материалов', m.stats.meshes + ' / ' + m.stats.materials],
      ['Габарит, юнита', m.stats.bbox.map(function (v) { return v.toFixed(3); }).join(' × ')],
      ['Низ модели, юнита', m.stats.origin ? m.stats.origin[1].toFixed(3) : '—'],
      ['Анимации в GLB', m.stats.animations.length ? m.stats.animations.join(', ') : 'нет'],
      ['Файл', kb(m.glb.bytes) + ' · sha ' + m.glb.sha]
    ]));

    card.appendChild(section('Камера рендера'));
    var cam = cameraDef();
    var cb = el('p', 'anote' + (cam.id === CAT.gameCanon ? '' : ' warn'));
    cb.appendChild(el('b', null, cam.title));
    cb.appendChild(el('div', null, 'объявлена в ' + cam.source));
    if (cam.mirror) {
      cb.appendChild(el('div', null, 'Базис камеры левый: кадр атласа зеркален ' +
        'обычному взгляду из той же точки. Стенд это повторяет — иначе «4 ' +
        'поворота» показывали бы не тот бок.'));
    }
    if (cam.id !== CAT.gameCanon) {
      cb.appendChild(el('div', null,
        'Канон игры — «' + CAT.cameras[CAT.gameCanon].title + '» (' +
        CAT.cameras[CAT.gameCanon].source + '). Кнопка «камера» показывает модель ' +
        'из другого квадранта: разбор — в art/characters/villager/README.md §2.'));
    }
    card.appendChild(cb);

    card.appendChild(section('Выгрузка в GLB'));
    card.appendChild(kv([
      ['Поворот', m.exportRot ? m.exportRot + '°' : 'нет'],
      ['Зеркало', cam.mirror ? 'да' : 'нет']
    ]));
    if (m.exportRot || cam.mirror) {
      var ex = el('p', 'anote');
      ex.appendChild(el('div', null, m.exportRot
        ? 'Экспортёр развернул геометрию на ' + m.exportRot + '° (дверь смотрит ' +
          'в glTF +Z), а кадры атласа рисовались без этого — стенд разворачивает ' +
          'обратно, иначе «4 поворота» показывали бы не тот бок.'
        : ''));
      ex.appendChild(el('div', null, cam.mirror
        ? 'Базис камеры проекта левый: кадр атласа зеркален обычному взгляду из ' +
          'той же точки. Стенд повторяет отражение — так модель выглядит в игре.'
        : ''));
      card.appendChild(ex);
    }

    card.appendChild(section('Палитра (' + m.palette.length + ')'));
    var sw = el('div', 'swatches');
    m.palette.forEach(function (p) {
      var d = el('div', 'sw');
      d.style.background = p.hex;
      d.title = p.hex + (p.name ? ' — ' + p.name : '');
      sw.appendChild(d);
    });
    card.appendChild(sw);

    card.appendChild(section('Атлас'));
    if (atlas) {
      var an = el('p', 'anote');
      an.appendChild(el('b', null, atlas.path));
      an.appendChild(el('div', null, (atlas.connected
        ? 'подключён: ' + atlas.pages.join(' и ') + ' — эти кадры игрок видит'
        : 'не подключён нигде: ' + 'модель собрана, но в игре её нет')));
      an.appendChild(el('div', null, atlas.frames.length + ' ' +
        plural(atlas.frames.length, 'кадр', 'кадра', 'кадров') + ' · ' +
        atlas.ppu + ' ppu · азимут ' + atlas.az + '°, подъём ' +
        Number(atlas.el).toFixed(4) + '°'));
      card.appendChild(an);
    } else {
      var nn = el('p', 'anote none');
      nn.appendChild(el('div', null, m.group === 'props'
        ? 'Своего атласа у предмета нет: он рисуется внутри кадров того, кто его держит.'
        : 'Атласа нет — модель в игру спрайтом не поехала.'));
      card.appendChild(nn);
    }

    card.appendChild(section('Файлы'));
    var ul = el('ul', 'paths');
    ul.appendChild(pathLink(m.glb.path, 'GLB, то что грузит стенд'));
    (m.blends || []).forEach(function (b, i) {
      ul.appendChild(pathLink(b, i === 0 ? 'сцена Blender' : 'сцена варианта'));
    });
    m.generators.forEach(function (g) { ul.appendChild(pathLink(g, 'генератор формы')); });
    if (m.readme) ul.appendChild(pathLink(m.readme, 'README проекта'));
    card.appendChild(ul);
  }

  /* ---------------------------- лента спрайтов -------------------------- */

  var spriteBar = document.getElementById('spriteBar');
  var spriteGrid = document.getElementById('spriteGrid');
  var player = null;                                 // таймер проигрывания

  function currentAtlas() {
    var m = MODEL_BY_ID[state.modelId];
    if (m && m.atlas && ATLAS_BY_NAME[m.atlas]) return ATLAS_BY_NAME[m.atlas];
    if (state.atlasName && ATLAS_BY_NAME[state.atlasName]) return ATLAS_BY_NAME[state.atlasName];
    return null;
  }

  function defaultZoom(atlas) {
    var h = 0;
    atlas.frames.forEach(function (f) { h = Math.max(h, f.h); });
    if (!h) return 0.5;
    return Math.max(0.08, Math.min(1.2, 108 / h));
  }

  function frameDiv(atlas, fr, zoom, hl) {
    var d = el('div', 'fr' + (hl ? ' hl' : ''));
    d.style.width = (fr.w * zoom) + 'px';
    d.style.height = (fr.h * zoom) + 'px';
    d.style.backgroundImage = 'url("' + BASE + atlas.image + '")';
    d.style.backgroundSize = (atlas.size[0] * zoom) + 'px ' + (atlas.size[1] * zoom) + 'px';
    d.style.backgroundPosition = (-fr.x * zoom) + 'px ' + (-fr.y * zoom) + 'px';
    d.title = fr.name + '  ' + fr.w + '×' + fr.h +
      (fr.rotation != null ? '  поворот ' + fr.rotation + '°' : '');
    return d;
  }

  function rowsFor(atlas) {
    var anims = Object.keys(atlas.anims || {});
    var rots = [];
    var variants = [];
    atlas.frames.forEach(function (f) {
      if (f.rotation != null && rots.indexOf(f.rotation) < 0) rots.push(f.rotation);
      if (f.variant && variants.indexOf(f.variant) < 0) variants.push(f.variant);
    });
    rots.sort(function (a, b) { return a - b; });
    variants.sort();
    if (anims.length) {
      var rot = state.rot || rots[0] || 0;
      return {
        kind: 'anim', rots: rots, variants: variants,
        rows: anims.map(function (a) {
          return {
            label: a,
            frames: atlas.frames.filter(function (f) {
              return f.anim === a && (f.rotation == null || f.rotation === rot);
            })
          };
        })
      };
    }
    if (variants.length > 1) {
      return {
        kind: 'variant', rots: rots, variants: variants,
        rows: variants.map(function (v) {
          return {
            label: 'вариант ' + v,
            frames: atlas.frames.filter(function (f) { return f.variant === v; })
          };
        })
      };
    }
    var rows = [], chunk = 8;
    for (var i = 0; i < atlas.frames.length; i += chunk) {
      rows.push({ label: String(i + 1) + '–' + Math.min(i + chunk, atlas.frames.length),
                  frames: atlas.frames.slice(i, i + chunk) });
    }
    return { kind: 'flat', rots: rots, variants: variants, rows: rows };
  }

  function renderSprites() {
    if (player) { clearInterval(player); player = null; }
    spriteBar.textContent = '';
    spriteGrid.textContent = '';
    var atlas = currentAtlas();
    if (!atlas) {
      spriteBar.appendChild(el('span', 'sp-title', 'Кадров нет'));
      spriteGrid.appendChild(el('div', 'empty',
        'У этой модели нет атласа: в игре она спрайтом не появляется.'));
      return;
    }
    var info = rowsFor(atlas);
    var m = MODEL_BY_ID[state.modelId] || {};      // модель может быть не выбрана
    var zoom = state.zoom == null ? defaultZoom(atlas) : state.zoom;

    spriteBar.appendChild(el('span', 'sp-title', 'Атлас ' + atlas.name));
    spriteBar.appendChild(atlas.connected ? badge('в игре', 'game') : badge('не подключён', 'ready'));

    if (info.kind === 'anim') {
      var anims = Object.keys(atlas.anims);
      if (!state.anim || anims.indexOf(state.anim) < 0) state.anim = anims[0];
      var ap = el('span', 'chips');
      anims.forEach(function (a) {
        var b = btn(a + ' · ' + atlas.anims[a].fps + ' fps', 'chip' + (a === state.anim ? ' active' : ''));
        b.addEventListener('click', function () { state.anim = a; renderSprites(); });
        ap.appendChild(b);
      });
      spriteBar.appendChild(ap);

      var rp = el('span', 'chips');
      info.rots.forEach(function (r) {
        var b = btn(r + '°', 'chip' + (r === (state.rot || info.rots[0]) ? ' active' : ''));
        b.addEventListener('click', function () { state.rot = r; renderSprites(); });
        rp.appendChild(b);
      });
      spriteBar.appendChild(rp);

      spriteBar.appendChild(playerWidget(atlas, info, zoom));
    } else if (info.rots.length > 1) {
      var rp2 = el('span', 'chips');
      rp2.appendChild(el('span', 'sp-note', 'столбцы — повороты: ' +
        info.rots.map(function (r) { return r + '°'; }).join(' / ')));
      spriteBar.appendChild(rp2);
    }

    spriteBar.appendChild(slider(zoom, function (v) { state.zoom = v; renderSprites(); }));

    var sheetBtn = btn(state.sheet ? '⤡ свернуть' : '⤢ во весь экран', 'chip');
    sheetBtn.title = 'лист кадров на всю высоту (F)';
    sheetBtn.addEventListener('click', toggleSheet);
    spriteBar.appendChild(sheetBtn);

    var firstRow = {};                               // куда прокрутить после отрисовки
    info.rows.forEach(function (row, i) {
      var line = el('div', 'srow');
      var full = row.frames.length;
      line.appendChild(el('div', 'slabel', row.label + ' · ' + full));
      if (info.kind === 'anim' && row.label === state.anim) firstRow.scroll = line;
      row.frames.forEach(function (fr) {
        var hl = !!(m && m.variant && fr.variant === m.variant);
        if (hl) firstRow.hit = true;
        line.appendChild(frameDiv(atlas, fr, zoom, hl || (info.kind === 'flat' && !m.variant)));
      });
      spriteGrid.appendChild(line);
    });

    var foot = el('div', 'sp-note');
    foot.style.padding = '4px 2px';
    foot.textContent = (atlas.note || '') +
      (firstRow.hit ? '  Зелёной рамкой — кадры выбранной модели.' : '');
    spriteGrid.appendChild(foot);

    if (firstRow.scroll) {
      spriteGrid.scrollTop = Math.max(0, firstRow.scroll.offsetTop - spriteGrid.offsetTop - 4);
    }
  }

  function toggleSheet() {
    state.sheet = !state.sheet;
    applyToggles();
    resize();
    renderSprites();
  }

  function slider(value, onChange) {
    var box = el('span', 'sp-slide');
    box.appendChild(el('span', null, 'зум'));
    var r = document.createElement('input');
    r.type = 'range';
    r.min = '5'; r.max = '200'; r.step = '1';
    r.value = String(Math.round(value * 100));
    r.addEventListener('input', function () { onChange(Number(r.value) / 100); });
    box.appendChild(r);
    box.appendChild(el('span', null, r.value + '%'));
    return box;
  }

  function playerWidget(atlas, info, zoom) {
    var anim = state.anim, rot = state.rot || info.rots[0] || 0;
    var frames = atlas.frames.filter(function (f) {
      return f.anim === anim && (f.rotation == null || f.rotation === rot);
    });
    var box = el('span', 'player');
    var holder = el('span');
    var idx = 0;
    function paint() { holder.textContent = ''; holder.appendChild(frameDiv(atlas, frames[idx], zoom, false)); }
    paint();
    var play = btn(state.playing ? '❚❚' : '▶', 'chip', function () {
      state.playing = !state.playing;
      play.textContent = state.playing ? '❚❚' : '▶';
      if (player) { clearInterval(player); player = null; }
      if (state.playing) {
        player = setInterval(function () { idx = (idx + 1) % frames.length; paint(); },
          1000 / (atlas.anims[anim].fps || 8));
      }
    });
    play.title = 'проиграть кадры с частотой из атласа';
    box.appendChild(play);
    box.appendChild(holder);
    box.appendChild(el('span', null, frames.length + ' ' +
      plural(frames.length, 'кадр', 'кадра', 'кадров') + ' × 1/' +
      (atlas.anims[anim].fps || 8) + ' с'));
    return box;
  }

  /* ---------------------------- переключение ---------------------------- */

  function select(id) {
    state.modelId = id;
    state.atlasName = null;
    state.zoom = null;
    state.anim = null;
    state.camMode = null;                            // у каждой модели своя камера
    var m = MODEL_BY_ID[id];
    note('загружаю ' + m.glb.path + '…');
    renderList();
    renderCard();
    renderSprites();
    renderCamChip();
    showModel(m, function () { refreshNote(); });
  }

  // Атлас, у которого 3D-модели в репозитории нет: вьюпорт очищается и говорит
  // почему, а лента кадров показывает то, что есть — спрайты. Молча оставлять
  // в окне прошлую модель нельзя: непонятно, что ты смотришь.
  function showAtlasOnly(name) {
    var a = ATLAS_BY_NAME[name];
    state.modelId = null;
    state.camMode = null;
    current = null;
    root.clear();
    clearHelpers();
    renderList();
    renderCard();
    renderSprites();
    renderCamChip();
    note('атлас «' + name + '»: 3D-модели в репозитории нет — ' +
      (a.origin || 'исходник не сохранён'));
  }

  function selectAtlas(name) {
    state.atlasName = name;
    state.zoom = null;
    state.anim = null;
    var a = ATLAS_BY_NAME[name];
    if (!a.models.length) { showAtlasOnly(name); return; }
    select(a.models[0]);
    state.atlasName = name;
    renderList();
    renderSprites();
  }

  function step(delta) {
    var items = visibleModels();
    if (!items.length) return;
    var i = items.findIndex(function (m) { return m.id === state.modelId; });
    if (i < 0) i = 0;
    var next = items[(i + delta + items.length) % items.length];
    select(next.id);
  }

  /* ------------------------------ управление ---------------------------- */

  function applyToggles() {
    document.querySelectorAll('#viewBar .chip[data-act]').forEach(function (b) {
      var act = b.dataset.act;
      if (act === 'reset' || act === 'cam') return;
      b.classList.toggle('active', !!state[act]);
    });
    document.getElementById('quadLabels').classList.toggle('hidden', !state.quad);
    document.getElementById('stage').classList.toggle('wide-sheet', state.sheet);
    if (current) applyMaterials(current.object);
    if (grid) grid.visible = state.grid;
    if (boxHelper) boxHelper.visible = state.box;
  }

  function renderCamChip() {
    var cam = cameraDef();
    var b = document.querySelector('#viewBar .chip[data-act="cam"]');
    b.textContent = 'камера: ' + (cam.id === CAT.gameCanon ? 'канон игры'
      : cam.id === 'pipeline' ? 'пайплайн' : 'разбор');
    b.classList.toggle('active', !state.iso);
    b.title = 'Камера рендера спрайтов: ' + cam.title + '\n' +
      'Объявлена в ' + cam.source + '\n' +
      'У каждой модели своя — так её рисовал Blender. Клик — следующая (C).';
  }

  function cycleCamera() {
    var order = Object.keys(CAT.cameras);
    var i = order.indexOf(cameraDef().id);
    state.camMode = order[(i + 1) % order.length];
    placeSun();
    if (current) { current.box = fit(current.object); setOrthoFrustum(); }
    renderCamChip();
    renderCard();
    refreshNote();
    draw();
  }

  document.getElementById('viewBar').addEventListener('click', function (e) {
    var b = e.target.closest('.chip[data-act]');
    if (!b) return;
    var act = b.dataset.act;
    if (act === 'reset') {
      if (current) { current.box = fit(current.object); setOrthoFrustum(); }
      return;
    }
    if (act === 'cam') { cycleCamera(); return; }
    if (act === 'quad') {
      state.quad = !state.quad;
      if (state.quad) state.iso = true;              // повороты сверяют с кадрами атласа
      setOrthoFrustum();
    } else {
      state[act] = !state[act];
    }
    applyToggles();
    renderCamChip();
    refreshNote();
    draw();
  });

  document.getElementById('filters').addEventListener('click', function (e) {
    var b = e.target.closest('.chip[data-filter]');
    if (!b) return;
    state.filter = b.dataset.filter;
    document.querySelectorAll('#filters .chip').forEach(function (c) {
      c.classList.toggle('active', c === b);
    });
    renderList();
    renderSprites();
  });

  document.getElementById('search').addEventListener('input', function (e) {
    state.query = e.target.value;
    renderList();
  });

  document.getElementById('helpBtn').addEventListener('click', function () {
    document.getElementById('help').classList.toggle('hidden');
  });
  document.getElementById('help').addEventListener('click', function () {
    document.getElementById('help').classList.add('hidden');
  });

  document.addEventListener('keydown', function (e) {
    var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if (e.key === 'Escape') {
      document.getElementById('help').classList.add('hidden');
      document.activeElement.blur();
      return;
    }
    if (typing && e.key !== 'Escape') return;
    if (e.key === '/' ) { e.preventDefault(); document.getElementById('search').focus(); return; }
    if (e.key === '?' ) { document.getElementById('help').classList.toggle('hidden'); return; }
    if (e.key === 'ArrowRight') { step(1); return; }
    if (e.key === 'ArrowLeft') { step(-1); return; }
    if (e.key >= '1' && e.key <= '9') {
      var items = visibleModels(), n = Number(e.key) - 1;
      if (items[n]) select(items[n].id);
      return;
    }
    var k = e.key.toLowerCase();
    if (k === 'c') { e.preventDefault(); cycleCamera(); return; }
    if (k === 'f') { e.preventDefault(); toggleSheet(); return; }
    var map = { i: 'iso', '4': 'quad', w: 'wire', g: 'grid', b: 'box', r: 'reset' };
    if (k === ' ') { e.preventDefault(); state.spin = !state.spin; applyToggles(); return; }
    if (map[k]) {
      e.preventDefault();
      var act = map[k];
      if (act === 'reset') {
        if (current) { current.box = fit(current.object); setOrthoFrustum(); }
      } else if (act === 'quad') {
        state.quad = !state.quad;
        if (state.quad) state.iso = true;
        setOrthoFrustum();
      } else {
        state[act] = !state[act];
      }
      applyToggles();
      renderCamChip();
      refreshNote();
    }
  });

  /* -------------------------------- старт ------------------------------- */

  if (DATA_MISSING.length) {
    var warn = el('div', 'databanner');
    warn.appendChild(el('b', null, 'Данные стенда разъехались: ' +
      DATA_MISSING.length + ' ' + plural(DATA_MISSING.length, 'модель', 'модели',
        'моделей') + ' без байтов в data/meshes.js.'));
    warn.appendChild(el('span', null, ' Пересоберите каталог: ' +
      'python3 art/tools/model-stand/tools/build_catalog.py — и обновите страницу.'));
    document.body.insertBefore(warn, document.getElementById('layout'));
  }

  var counts = CAT.counts;
  document.getElementById('counts').textContent =
    counts.models + ' ' + plural(counts.models, 'модель', 'модели', 'моделей') +
    ' · ' + counts.inGame + ' в игре · ' +
    counts.atlases + ' ' + plural(counts.atlases, 'атлас', 'атласа', 'атласов') +
    ' · ' + counts.frames + ' ' + plural(counts.frames, 'кадр', 'кадра', 'кадров') +
    ' · каталог ' + CAT.generated;

  if (state.iso) setOrthoFrustum();
  // Подписи квадрантов «4 поворотов» — те же углы, что в именах кадров атласа.
  var quadLabels = document.getElementById('quadLabels');
  ['0°', '90°', '180°', '270°'].forEach(function (t) {
    quadLabels.appendChild(el('span', null, t));
  });
  applyToggles();
  renderCamChip();
  renderList();
  renderCard();
  renderSprites();
  select(state.modelId);

  new ResizeObserver(function () { resize(); }).observe(wrap);
  window.addEventListener('resize', resize);
  resize();
  loop();

  window.__stand = {                                  // для приёмки tools/shot.js
    state: state, select: select, selectAtlas: selectAtlas,
    catalog: CAT,
    ready: function () { return !loading && !!current; },
    info: function () {
      if (!current) return null;
      var tris = 0;
      current.object.traverse(function (o) {
        if (!o.isMesh || !o.geometry) return;
        var g = o.geometry;
        tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
      });
      return {
        meshKey: current.meshKey,
        size: current.box.getSize(new THREE.Vector3()).toArray(),
        tris3: Math.round(tris),
        tris: MODEL_BY_ID[current.meshKey].stats.tris,
        frames: document.querySelectorAll('#spriteGrid .fr').length
      };
    },
    canvasStats: function () {                        // пустой ли кадр вьюпорта
      var c2 = document.createElement('canvas');
      c2.width = 160; c2.height = 120;
      var ctx = c2.getContext('2d');
      ctx.drawImage(canvas, 0, 0, c2.width, c2.height);
      var d = ctx.getImageData(0, 0, c2.width, c2.height).data;
      var seen = {};
      for (var i = 0; i < d.length; i += 4) {
        seen[d[i] + ',' + d[i + 1] + ',' + d[i + 2]] = 1;
      }
      return { colors: Object.keys(seen).length };
    },
    setQuad: function (on) { state.quad = !!on; state.iso = !!on; applyToggles(); renderCamChip(); setOrthoFrustum(); },
    setIso: function (on) { state.iso = !!on; applyToggles(); renderCamChip(); setOrthoFrustum(); },
    setWire: function (on) { state.wire = !!on; applyToggles(); },
    setSpin: function (on) { state.spin = !!on; applyToggles(); },
    setAtlas: function (name) { state.atlasName = name; renderSprites(); },
    setCamera: function (mode) { state.camMode = mode; placeSun(); if (current) { current.box = fit(current.object); setOrthoFrustum(); } renderCamChip(); refreshNote(); },
    cycleCamera: cycleCamera,
    camera: function () { var c = cameraDef(); return { id: c.id, title: c.title, source: c.source, sun: toThree(c.sun).toArray() }; },
    setSheet: function (on) { if (!!on !== state.sheet) toggleSheet(); },
    setAnim: function (a, rot) {
      if (a != null) state.anim = a;
      if (rot != null) state.rot = rot;
      state.zoom = null;
      renderSprites();
    }
  };
})();
