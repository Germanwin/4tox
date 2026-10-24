#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""build_catalog.py — собирает каталог 3D-моделей и атласов для стенда.

Читает репозиторий и пишет три файла в `data/` стенда:

  catalog.json — что нашлось: модель за моделью, числа и пути (для человека)
  catalog.js   — то же как `window.MODEL_STAND_CATALOG = {...}` (для страницы)
  meshes.js    — байты GLB в base64: `window.MODEL_STAND_MESHES = {...}`

Зачем base64: стенд открывается двойным кликом по `index.html`, то есть по
`file://`, где `fetch` и XHR до файла запрещены. Тот же приём, что у
`mapgen2/assets/*/atlas.js`.

Ровно как в игре: **числа считаются здесь, а не глазами**. Треугольники,
вершины, материалы и габарит берутся из самого GLB, а не из README проекта —
README может отстать, файл врёт редко.

Запуск:
    python3 tools/build_catalog.py            # пересобрать
    python3 tools/build_catalog.py --check     # только проверить, что не устарел

`--check` возвращает 1, если каталог на диске разошёлся с репозиторием: значит,
модель перерисовали, а стенд показывает старое.

Чистый Python, без bpy и без зависимостей: файл читается как данные, а не
собирается в Blender.
"""

import base64
import datetime
import hashlib
import json
import os
import re
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))                 # .../model-stand/tools
STAND = os.path.dirname(HERE)                                     # .../model-stand
REPO = os.path.abspath(os.path.join(STAND, '..', '..', '..'))     # корень 4tox
DATA = os.path.join(STAND, 'data')

# Где искать модели. Порядок = порядок групп в стенде.
SEARCH_ROOTS = ['art', 'research', 'experiments']

# Кто есть кто. Ключ — начало пути GLB от корня репозитория.
# Группа — роль объекта в игре, как в art/README.md, а не техника исполнения.
#
# `camera` — из какого квадранта смотрел Blender, когда рисовал спрайты этой
# модели. В репозитории их три, и это не описка, а история: ратуша, дом, лагерь
# и предметы рендерились общим пайплайном (−X +Y), житель — камерой канона игры
# (+X +Y), дом из разбора — своей.
#
# `mirror` — базис камеры левый, то есть кадр атласа зеркален обычному взгляду
# из той же точки. Проверяется определителем: у thpipe.py
# det(right, up, eye) = +1 (обычная камера), у scene.py жителя −1. И это не
# теория: проекция геометрии жителя на позе рубки (она резко несимметричная —
# топор в правом кулаке) совпадает с кадром атласа при IoU 0.69, а зеркальная
# проекция даёт 0.47. Стенд повторяет отражение, иначе «4 поворота» показывали
# бы не тот бок, что в спрайтах. Разбор — в README стенда и в
# art/characters/villager/README.md §2.
CAMERAS = {
    'pipeline': dict(
        title='общий пайплайн, −X +Y',
        eye=[-0.57735, 0.57735, 0.57735],
        sun=[-0.36, 0.30, 0.88],
        mirror=False,
        source='art/buildings/townhall/tools/thpipe.py'),
    'game': dict(
        title='канон игры, +X +Y',
        eye=[0.57735, 0.57735, 0.57735],
        sun=[0.36, 0.30, 0.88],
        mirror=True,
        source='art/characters/villager/tools/scene.py'),
    'other': dict(
        title='камера разбора, +X −Y',
        eye=[0.57735, -0.57735, 0.57735],
        sun=[-0.36, 0.30, 0.88],
        mirror=False,
        source='research/coc_house/tools/build_house.py'),
}
GAME_CANON = 'game'

RULES = [
    ('art/buildings/townhall/out/townhall_', dict(
        group='buildings', title='Ратуша', atlas='townhall', camera='pipeline',
        export_rot=180,
        where='в игре: слой построек, 3 варианта x 4 поворота')),
    ('art/buildings/townhall/out/hutrect_', dict(
        group='buildings', title='Хижина', atlas='hut', camera='pipeline',
        export_rot=180,
        where='атлас hut собран, в игру не подключён')),
    ('art/buildings/villager_house/out/house_', dict(
        group='buildings', title='Прежний дом жителя (3 x 2)', atlas='house',
        camera='pipeline',
        where='атлас house собран, но игра его не грузит: дом жителя в игре — '
              'стартовый дом (art/buildings/starter_house)')),
    ('art/buildings/starter_house/out/starter_house_model', dict(
        group='buildings', title='Дом жителя — стартовый дом (2 x 3)',
        atlas='starter_house', camera='pipeline',
        where='в игре: тип house, деревня на старте партии')),
    ('art/buildings/starter_house/out/starter_house', dict(
        group='buildings', title='Стартовый дом — первая ревизия (забракована)',
        atlas=None, camera='pipeline',
        where='не в игре: заменена моделью starter_house_model (tools/rev2)')),
    ('art/buildings/lumbercamp/out/lc_model', dict(
        group='buildings', title='Лагерь лесоруба', atlas='lumbercamp',
        camera='pipeline',
        where='в игре: деревня на старте партии, 4 поворота')),
    ('art/characters/villager/out/villager', dict(
        group='characters', title='Житель', atlas='villager', camera='game',
        where='в игре: слои villager и hero')),
    ('art/props/axe/out/axe_', dict(
        group='props', title='Топор', atlas='villager', camera='pipeline',
        where='в игре: в правом кулаке жителя, кадры work')),
    ('art/props/shovel/out/shovel_', dict(
        group='props', title='Лопата', atlas=None, camera='pipeline',
        where='в игре не используется')),
    ('art/fx/waves/out/wave_', dict(
        group='fx', title='Гребень волны', atlas='waves', camera='pipeline',
        where='в игре: слой волн, 5 форм x 2 поворота вала')),
    ('research/coc_house/out/coc_house', dict(
        group='research', title='Дом (разбор чужого ассета)', atlas=None,
        camera='other', where='разбор: не для игры')),
]

# Поворот, который экспортёр запекает в GLB. Кадры атласа рисуются с модели
# БЕЗ него, поэтому стенд разворачивает модель обратно — иначе «4 поворота»
# показывали бы не тот бок. У хижины и ратуши это 180°: их экспортёры
# разворачивают геометрию так, чтобы дверь смотрела в glTF +Z
# (export_hut_rect.py, export_townhall.py), а в сцене дверь стоит в +Y Blender.
# Проверено замером: в спрайте hutrect_b_0 труба на 39.7 px ЛЕВЕЕ центра
# силуэта, а в GLB при повороте 0 — на 39.4 px правее (80 ppu).
EXPORT_ROT = {
    'art/buildings/townhall/out/townhall_': 180,
    'art/buildings/townhall/out/hutrect_': 180,
}

GROUPS = [
    ('buildings', 'Постройки'),
    ('characters', 'Люди'),
    ('props', 'Предметы'),
    ('fx', 'Эффекты'),
    ('research', 'Разборы'),
]

# Откуда у атласа геометрия. Нужно там, где GLB нет вовсе: атлас есть, модели
# в выгрузке нет — и это надо сказать вслух, а не показывать пустое место.
ATLAS_ORIGIN = {
    'sprites': 'атлас унаследован — исходных моделей в репозитории нет',
    'hero': 'атлас унаследован — исходных моделей в репозитории нет',
    'waves': 'art/fx/waves/tools — геометрия на чистом Python, .blend и GLB не выгружались',
    'lumbercamp': 'art/buildings/lumbercamp/tools/building.py — .blend и GLB не выгружались',
    'townhall': 'art/buildings/townhall/tools/hut.py — GLB ратуши не выгружался, только спрайты',
}

# Уточнения по конкретной модели там, где правило по префиксу врёт.
# `inGame` — видит ли это игрок сейчас; по умолчанию решает подключённый атлас.
OVERRIDES = {
    'art/props/axe/out/axe_b': dict(
        where='в игре: топор в правом кулаке жителя, кадры work', inGame=True),
    'art/props/axe/out/axe_a': dict(
        where='в наборе: вариант в игре не встречается (канон — b)', inGame=False),
    'art/props/axe/out/axe_c': dict(
        where='в наборе: вариант в игре не встречается (канон — b)', inGame=False),
}


# ------------------------------- GLB ---------------------------------------

def read_glb(path):
    """Заголовок, JSON-чанк и BIN-чанк контейнера GLB (glTF 2.0)."""
    with open(path, 'rb') as f:
        raw = f.read()
    magic, version, length = struct.unpack('<4sII', raw[:12])
    if magic != b'glTF':
        raise ValueError('не GLB: %s' % path)
    off, js, bin_chunk = 12, None, b''
    while off < min(length, len(raw)):
        clen, ctype = struct.unpack('<I4s', raw[off:off + 8])
        chunk = raw[off + 8:off + 8 + clen]
        if ctype == b'JSON':
            js = json.loads(chunk.decode('utf-8'))
        elif ctype == b'BIN\x00':
            bin_chunk = chunk
        off += 8 + clen
    if js is None:
        raise ValueError('в GLB нет JSON-чанка: %s' % path)
    return js, bin_chunk, raw


def mat_identity():
    return [1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0]


def mat_mul(a, b):
    """a * b для 4x4, записанных по столбцам (как в glTF)."""
    out = [0.0] * 16
    for c in range(4):
        for r in range(4):
            out[c * 4 + r] = sum(a[k * 4 + r] * b[c * 4 + k] for k in range(4))
    return out


def mat_from_trs(node):
    if 'matrix' in node:
        return list(node['matrix'])
    t = node.get('translation', [0.0, 0.0, 0.0])
    r = node.get('rotation', [0.0, 0.0, 0.0, 1.0])
    s = node.get('scale', [1.0, 1.0, 1.0])
    x, y, z, w = r
    # кватернион -> матрица 3x3, затем масштаб и перенос
    m = [
        1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0.0,
        2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0.0,
        2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0.0,
        0.0, 0.0, 0.0, 1.0,
    ]
    for c in range(3):
        for r_i in range(3):
            m[c * 4 + r_i] *= s[c]
    m[12], m[13], m[14] = t
    return m


def mat_apply(m, p):
    x, y, z = p
    return (m[0] * x + m[4] * y + m[8] * z + m[12],
            m[1] * x + m[5] * y + m[9] * z + m[13],
            m[2] * x + m[6] * y + m[10] * z + m[14])


def glb_stats(js):
    """Треугольники, вершины, меши, материалы и габарит в осях модели."""
    tris = verts = prims = 0
    for mesh in js.get('meshes', []):
        for pr in mesh.get('primitives', []):
            prims += 1
            if 'indices' in pr:
                tris += js['accessors'][pr['indices']]['count'] // 3
            if 'POSITION' in pr['attributes']:
                verts += js['accessors'][pr['attributes']['POSITION']]['count']

    lo = [float('inf')] * 3
    hi = [float('-inf')] * 3

    def walk(idx, parent):
        node = js['nodes'][idx]
        world = mat_mul(parent, mat_from_trs(node))
        if 'mesh' in node:
            for pr in js['meshes'][node['mesh']].get('primitives', []):
                acc = js['accessors'][pr['attributes']['POSITION']]
                amin, amax = acc.get('min'), acc.get('max')
                if not amin or not amax:
                    continue
                for cx in (amin[0], amax[0]):
                    for cy in (amin[1], amax[1]):
                        for cz in (amin[2], amax[2]):
                            p = mat_apply(world, (cx, cy, cz))
                            for i in range(3):
                                lo[i] = min(lo[i], p[i])
                                hi[i] = max(hi[i], p[i])
        for child in node.get('children', []):
            walk(child, world)

    scene = js.get('scenes', [{}])[js.get('scene', 0)]
    for idx in scene.get('nodes', []):
        walk(idx, mat_identity())

    bbox = None
    if lo[0] != float('inf'):
        bbox = [round(hi[i] - lo[i], 4) for i in range(3)]
    return dict(tris=tris, verts=verts, meshes=len(js.get('meshes', [])),
                primitives=prims, materials=len(js.get('materials', [])),
                nodes=len(js.get('nodes', [])), images=len(js.get('images', [])),
                animations=[a.get('name') or ('anim %d' % i)
                            for i, a in enumerate(js.get('animations', []))],
                bbox=bbox, origin=[round(v, 4) for v in lo] if bbox else None)


def glb_palette(js):
    """Цвета материалов без повторов — палитра модели как она есть в файле."""
    seen, out = set(), []
    for mat in js.get('materials', []):
        pbr = mat.get('pbrMetallicRoughness', {})
        c = pbr.get('baseColorFactor', [1.0, 1.0, 1.0, 1.0])
        key = tuple(round(v, 4) for v in c)
        if key in seen:
            continue
        seen.add(key)
        hexed = '#%02x%02x%02x' % tuple(
            max(0, min(255, int(round(v ** (1 / 2.2) * 255)))) for v in c[:3])
        out.append(dict(hex=hexed, rgba=[round(v, 4) for v in c],
                        name=mat.get('name', '')))
    return out


# ------------------------------ PNG ---------------------------------------

def png_size(path):
    """Размер картинки из IHDR — чтобы стенд знал, как резать атлас."""
    with open(path, 'rb') as f:
        head = f.read(33)
    if head[:8] != b'\x89PNG\r\n\x1a\n' or head[12:16] != b'IHDR':
        return None
    w, h = struct.unpack('>II', head[16:24])
    return [w, h]


# ----------------------------- каталог ------------------------------------

def rel(path):
    return os.path.relpath(path, REPO).replace(os.sep, '/')


def rule_for(relpath):
    for prefix, info in RULES:
        if relpath.startswith(prefix):
            return info
    return None


def find_files(basename, folder, depth=2):
    """Ближайший файл с таким именем вверх по проекту (для .blend и README)."""
    cur = folder
    for _ in range(depth):
        cand = os.path.join(cur, basename)
        if os.path.isfile(cand):
            return rel(cand)
        cur = os.path.dirname(cur)
    return None


# Имена генераторов формы в проектах art/. Список явный: угадывать по «в tools
# лежит какой-то .py» нельзя — там же и пайплайн рендера, и упаковщик.
GENERATOR_NAMES = ('building.py', 'figure.py', 'villager.py', 'hero.py', 'axe.py',
                   'shovel.py', 'house.py', 'hut.py', 'townhall.py', 'geom.py',
                   'wave_models.py', 'wave_shapes.py', 'coc_house.py')


def variant_letter(stem):
    """Метка варианта в имени файла: hutrect_b → B, wave_0 → 0."""
    for tail in ('_a', '_b', '_c', '_d'):
        if stem.endswith(tail):
            return tail[-1].upper()
    m = re.search(r'_(\d+)$', stem)
    return m.group(1) if m else None


def collect_models():
    found = []
    for root in SEARCH_ROOTS:
        base = os.path.join(REPO, root)
        if not os.path.isdir(base):
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [d for d in dirnames
                           if d not in ('.git', '__pycache__', 'node_modules')]
            for name in sorted(filenames):
                if not name.lower().endswith('.glb'):
                    continue
                full = os.path.join(dirpath, name)
                relpath = rel(full)
                info = rule_for(relpath)
                if info is None:
                    info = dict(group='research', title=name[:-4], atlas=None,
                                where='не описано в правилах каталога')
                over = OVERRIDES.get(relpath[:-4], {})
                with open(full, 'rb') as f:
                    raw = f.read()
                js, _bin, _all = read_glb(full)
                stats = glb_stats(js)
                stem = name[:-4]
                project = os.path.dirname(os.path.dirname(full))   # .../<проект>
                title = info['title']
                letter = variant_letter(stem)
                if letter:
                    title = '%s %s' % (title, letter)
                model_id = relpath[:-4]

                # .blend-сцены проекта: точное совпадение по имени файла, иначе
                # единственная сцена проекта; их может быть несколько (по варианту).
                blends = sorted(f for f in os.listdir(project) if f.endswith('.blend'))
                exact = stem + '.blend'
                blend = rel(os.path.join(project, exact)) if exact in blends else (
                    rel(os.path.join(project, blends[0])) if blends else None)

                gen_dir = os.path.join(project, 'tools')
                generators = sorted(
                    rel(os.path.join(gen_dir, n)) for n in GENERATOR_NAMES
                    if os.path.isfile(os.path.join(gen_dir, n)))

                found.append(dict(
                    id=model_id,
                    title=title,
                    group=info['group'],
                    groupName=dict(GROUPS).get(info['group'], info['group']),
                    variant=letter,
                    where=over.get('where', info['where']),
                    inGame=over.get('inGame'),
                    atlas=info.get('atlas'),
                    camera=info.get('camera', 'pipeline'),
                    mirror=bool(CAMERAS.get(info.get('camera', 'pipeline'), {}).get('mirror')),
                    exportRot=info.get('export_rot', 0),
                    project=os.path.dirname(os.path.dirname(model_id)),
                    glb=dict(path=relpath, bytes=len(raw),
                             sha=hashlib.sha256(raw).hexdigest()[:12]),
                    blend=blend,
                    blends=[rel(os.path.join(project, b)) for b in blends],
                    generators=generators,
                    readme=find_files('README.md', project, depth=1),
                    stats=stats,
                    palette=glb_palette(js),
                    meshKey=model_id,
                ))
    return found


def collect_atlases(models):
    base = os.path.join(REPO, 'mapgen2', 'assets')
    # Атлас «в игре», если его грузит хоть одна страница: игра (game/) или
    # генератор карт (mapgen2/). Копий атласов нет — обе берут mapgen2/assets/.
    pages = [('игра', 'game/index.html'), ('генератор карт', 'mapgen2/index.html')]
    page_text = {}
    for label, relpath in pages:
        path = os.path.join(REPO, relpath)
        page_text[label] = open(path, encoding='utf-8').read() if os.path.isfile(path) else ''
    out = []
    for name in sorted(os.listdir(base)):
        meta_path = os.path.join(base, name, 'atlas.json')
        if not os.path.isfile(meta_path):
            continue
        meta = json.load(open(meta_path, encoding='utf-8'))
        png = os.path.join(base, name, 'atlas.png')
        frames = meta.get('frames', {})
        compact = []
        for fname in sorted(frames):
            fr = frames[fname]
            compact.append(dict(
                name=fname, x=fr['x'], y=fr['y'], w=fr['w'], h=fr['h'],
                rotation=fr.get('rotation'), variant=fr.get('variant'),
                anim=fr.get('anim'), frame=fr.get('frame'),
                anchorX=fr.get('anchorX'), anchorY=fr.get('anchorY'),
                footprint=fr.get('footprint')))
        used = [m['id'] for m in models if m.get('atlas') == name]
        projects = []
        for mid in used:
            proj = os.path.dirname(os.path.dirname(mid))
            if proj not in projects:
                projects.append(proj)
        origin = ATLAS_ORIGIN.get(name, '')
        if not origin and projects:
            origin = 'исходники: ' + ', '.join(projects)
        where = [label for label in page_text
                 if ('assets/%s/atlas.js' % name) in page_text[label]]
        out.append(dict(
            name=name,
            path='mapgen2/assets/%s' % name,
            image='mapgen2/assets/%s/atlas.png' % name,
            size=png_size(png),
            connected=bool(where),
            pages=where,
            ppu=meta.get('ppu'), az=meta.get('az_deg'), el=meta.get('el_deg'),
            res=meta.get('res'), mul=meta.get('mul'), cell=meta.get('cell'),
            anims=meta.get('anims') or {},
            variants=meta.get('variants') or {},
            note=meta.get('note', ''),
            frames=compact,
            models=used,
            origin=origin,
        ))
    return out


def is_in_game(model, atlases):
    """Видит ли игрок эту модель. Явная пометка сильнее вывода по атласу."""
    if model.get('inGame') is not None:
        return bool(model['inGame'])
    return any(a['name'] == model.get('atlas') and a['connected'] for a in atlases)


def build():
    models = collect_models()
    atlases = collect_atlases(models)
    for m in models:
        m['inGame'] = is_in_game(m, atlases)
    # Порядок в списке стенда: по группам, а внутри группы — сначала то, что
    # игрок видит в игре. Иначе первым в списке оказывается лагерь лесоруба,
    # которого в игре нет, а ратуша — только пятой строкой, и на низком окне
    # её вообще не видно без прокрутки.
    models.sort(key=lambda m: ([g for g, _ in GROUPS].index(m['group'])
                               if m['group'] in dict(GROUPS) else 99,
                               0 if m['inGame'] else 1,
                               m['id']))
    return dict(
        generated=datetime.datetime.now().strftime('%Y-%m-%d %H:%M'),
        groups=[dict(id=g, name=n) for g, n in GROUPS],
        cameras=CAMERAS,
        gameCanon=GAME_CANON,
        counts=dict(models=len(models),
                    inGame=sum(1 for m in models if m['inGame']),
                    atlases=len(atlases),
                    frames=sum(len(a['frames']) for a in atlases)),
        models=models,
        atlases=atlases,
    )


def payload(cat):
    """meshes.js — байты GLB в base64. Отдельным файлом: каталог читают глазами."""
    chunks = []
    for m in cat['models']:
        with open(os.path.join(REPO, m['glb']['path']), 'rb') as f:
            b64 = base64.b64encode(f.read()).decode('ascii')
        chunks.append('"%s":"%s"' % (m['meshKey'], b64))
    return 'window.MODEL_STAND_MESHES = {\n' + ',\n'.join(chunks) + '\n};\n'


def write_text(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write(text)
    os.replace(tmp, path)


def payload_of(text):
    """Разобрать catalog.json или catalog.js обратно в объект (для --check)."""
    if text.lstrip().startswith('{'):
        return json.loads(text)
    body = text[text.index('=') + 1:]
    return json.loads(body.rstrip().rstrip(';').rstrip())


def main():
    check = '--check' in sys.argv
    cat = build()
    body = json.dumps(cat, ensure_ascii=False, indent=1)
    files = {
        os.path.join(DATA, 'catalog.json'): body + '\n',
        os.path.join(DATA, 'catalog.js'):
            '/* каталог стенда — сборка: tools/build_catalog.py, не править руками */\n'
            'window.MODEL_STAND_CATALOG = ' + json.dumps(cat, ensure_ascii=False,
                                                         separators=(',', ':')) + ';\n',
        os.path.join(DATA, 'meshes.js'): payload(cat),
    }

    if check:
        stale = []
        for path, text in files.items():
            old = open(path, encoding='utf-8').read() if os.path.isfile(path) else ''
            if path.endswith('meshes.js'):
                if old != text:
                    stale.append(path)
                continue
            # Время сборки в сравнении не участвует: иначе проверка всегда
            # красная, и её перестают смотреть.
            a, b = payload_of(old or '{}'), payload_of(text)
            a.pop('generated', None)
            b.pop('generated', None)
            if a != b:
                stale.append(path)
        if stale:
            print('каталог устарел:')
            for p in stale:
                print('  ' + rel(p))
            print('пересобрать: python3 art/tools/model-stand/tools/build_catalog.py')
            return 1
        print('каталог свежий: %d моделей, %d атласов, %d кадров'
              % (cat['counts']['models'], cat['counts']['atlases'],
                 cat['counts']['frames']))
        return 0

    for path, text in files.items():
        write_text(path, text)
        print('  %-34s %7.1f КБ' % (rel(path), len(text.encode('utf-8')) / 1024.0))
    print('моделей %d (в игре %d), атласов %d, кадров %d'
          % (cat['counts']['models'], cat['counts']['inGame'],
             cat['counts']['atlases'], cat['counts']['frames']))
    for m in cat['models']:
        print('  %-46s %5d трис  %-22s %s'
              % (m['id'], m['stats']['tris'],
                 '×'.join('%.2f' % v for v in (m['stats']['bbox'] or [])),
                 m['where']))
    return 0


if __name__ == '__main__':
    sys.exit(main())
