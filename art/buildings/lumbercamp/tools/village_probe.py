"""village_probe.py — ПРОБА: что краска ратуши даёт в кадре. Пишет палитру деревни.

Зачем проба, а не арифметика «на глаз».  Тон в спрайте поднимает СЦЕНА (солнце
2.05 + небо 0.62/0.66/0.72 силой 0.42), а не материал: базовый цвет материала
темнее того, что видно в кадре.  Причём поднимает по-разному — грань в небо
ловит больше, грань в тень меньше, да ещё небо подсинивает тень.  Формулу
«base x k» без замера не угадать, поэтому она и ЗАМЕРЯЕТСЯ: та же краска
кладётся на фасеты с ИЗВЕСТНЫМИ нормалями, кадр снимается канонной камерой, и
из кадра читается результат.

Так делает и остальной проект (`axe/tools/calib_render.py`,
`shovel/tools/calib_render.py`, `villager_house/tools/calib_live.py` — «пробы по
нормалям тонов»).  Отличие одно: там проба подбирает базовые цвета под готовые
тона атласа, а здесь она читает тона с уже готовой краски ратуши.

ДВА ШАГА, И ЭТО НАРОЧНО.  Проба разделена на рендер (внутри Blender) и замер
(снаружи, Pillow):

    $PY  tools/mcp.py run tools/village_probe.py     # шаг 1: рендер проб
    $PY3 tools/village_probe.py --sample             # шаг 2: палитра деревни

Почему не одним куском: первая версия читала кадр через `bpy.data.images`
прямо в живом Blender — и Blender УПАЛ (окно заказчика закрылось).  Pillow
внутри Blender нет, а трогать его image-API в контексте таймера аддона не
стоит: рендер и замер живут в разных процессах.

Выход шага 2 — `tools/village_palette.json` в формате палитры канона
(`references/palette.json`), чтобы стиль-гейт
(`4tox-lowpoly-3d/scripts/audit.py`) мог проверить лагерь по палитре ДЕРЕВНИ,
а не по атласу природы:

    $PY3 <скилл>/scripts/audit.py --mine out/lc_0.png --kind building \\
         --palette tools/village_palette.json --anchor 355,389 --tris 982
"""
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if HERE not in sys.path:
    sys.path.insert(0, HERE)

try:
    import bpy
    IN_BLENDER = True
except ImportError:                                   # шаг 2 — снаружи
    bpy = None
    IN_BLENDER = False

if IN_BLENDER:
    from mathutils import Vector

SCENE = 'lc_probe'
PREFIX = 'lcp_'
OUT = os.path.join(HERE, 'village_palette.json')
PLATES = os.path.join(ROOT, 'renders', 'probe_plates.json')
RES = (512, 640)
PPU = 96.0

# Нормали пробы: грань строится как n = c*sun + sqrt(1-c^2)*t, где t — единичный
# вектор, перпендикулярный солнцу и наклонённый к камере.  Так нормаль остаётся
# ВИДИМОЙ камере при любом `c` — иначе фасет просто не попадёт в кадр.
# `c` — косинус угла к солнцу, то есть ровно то, чем мерит тона
# `canon.face_brightness`.
PROBE_C = (0.30, 0.45, 0.60, 0.75, 0.90)
BANDS = (('light', 0.90), ('mid', 0.60), ('dark', 0.30))   # тон -> косинус

AZ = math.radians(45.0)
EL = math.atan(1.0 / math.sqrt(2.0))
SUN_DIR = (-0.36, 0.30, 0.88)
SUN = None
CAM = None


def project(p):
    """Мир -> пиксель кадра.  Базис тот же, что у `xray.render` (и карты игры):
    он сходится с альфа-каналом кадра по IoU 0.999 (замер `village_check.py`).

    Зеркало по X — не ошибка, а развилка осей из README («рендер построек
    смотрит не с той стороны»): камера пайплайна стоит со стороны (-x, +y), а
    базис выше построен как у карты игры.  Без зеркала проба читала бы цвет
    соседней пластины.
    """
    right = (math.cos(AZ), math.sin(AZ), 0.0)
    fwd = (math.cos(EL) * math.cos(AZ), -math.cos(EL) * math.sin(AZ), -math.sin(EL))
    up = (-fwd[1] * right[2] + fwd[2] * right[1],
          -fwd[2] * right[0] + fwd[0] * right[2],
          -fwd[0] * right[1] + fwd[1] * right[0])
    sx = RES[0] / 2.0 + sum(p[i] * right[i] for i in range(3)) * PPU
    sy = RES[1] / 2.0 + sum(p[i] * up[i] for i in range(3)) * PPU
    return int(round(RES[0] - sx)), int(round(sy))


# --------------------------------------------------------------------------
# ШАГ 1: РЕНДЕР ПРОБ (внутри Blender)
# --------------------------------------------------------------------------
def render_pass():
    import bmesh
    from mathutils import Vector as _V

    def _pin(name, path):
        import importlib.util
        spec = importlib.util.spec_from_file_location(name, path)
        mod = importlib.util.module_from_spec(spec)
        sys.modules[name] = mod
        spec.loader.exec_module(mod)
        return mod

    V = _pin('village', os.path.join(HERE, 'village.py'))
    BL = _pin('blender_live', os.path.join(HERE, 'blender_live.py'))
    sun = _V(BL.SUN_DIR).normalized()
    cam = _V((-math.cos(BL.EL) * math.cos(BL.AZ),
              math.cos(BL.EL) * math.sin(BL.AZ), math.sin(BL.EL))).normalized()

    def probe_normal(c):
        t = (cam - cam.dot(sun) * sun).normalized()
        return (c * sun + math.sqrt(max(0.0, 1.0 - c * c)) * t).normalized()

    def plate(bm, center, normal, size):
        n = _V(normal).normalized()
        a = _V((0.0, 0.0, 1.0))
        if abs(n.dot(a)) > 0.95:
            a = _V((1.0, 0.0, 0.0))
        u = n.cross(a).normalized()
        w = n.cross(u).normalized()
        c = _V(center)
        h = size / 2.0
        vs = [bm.verts.new(p) for p in (c - u * h - w * h, c + u * h - w * h,
                                        c + u * h + w * h, c - u * h + w * h)]
        bm.faces.new(vs)

    sc = BL.use_scene(SCENE)
    print('сцена пробы: %r (сцен в файле: %s)'
          % (sc.name, [s.name for s in bpy.data.scenes]))
    BL.setup(sc, PREFIX, ppu=PPU, res=RES, samples=32)
    zone_of = {}
    for z in V.ZONES:
        zone_of.setdefault(V.paint_name(z), z)
    paints = sorted(zone_of)
    table = {}
    for c in PROBE_C:
        for ob in list(sc.objects):
            if ob.name.startswith(PREFIX) and ob.type == 'MESH':
                bpy.data.objects.remove(ob, do_unlink=True)
        n = probe_normal(c)
        gap, size = 0.46, 0.30
        x0 = -(len(paints) - 1) * gap / 2.0
        cz = 0.35 + 0.22 * (1.0 - n.z)
        row = {}
        for i, name in enumerate(paints):
            bm = bmesh.new()
            center = (x0 + i * gap, 0.0, cz)
            plate(bm, center, n, size)
            me = bpy.data.meshes.new('%s%s' % (PREFIX, name))
            bm.to_mesh(me)
            bm.free()
            for p in me.polygons:
                p.use_smooth = False
            ob = bpy.data.objects.new(me.name, me)
            sc.collection.objects.link(ob)
            hex_lin, rough, spec = V.paint(zone_of[name])
            ob.data.materials.append(BL.make_material(
                '%s%s' % (PREFIX, name), hex_lin, rough=rough, spec=spec))
            row[name] = list(project(center))
        raw = os.path.join(ROOT, 'renders', 'probe_c%02d_raw.png' % int(c * 100))
        BL.render_to(raw, sc)
        table['%.2f' % c] = dict(frame=raw, at=row)
        print('  проба c=%.2f: %d красок -> %s'
              % (c, len(paints), os.path.basename(raw)))
    with open(PLATES, 'w', encoding='utf-8') as f:
        json.dump(dict(paints=paints, passes=table), f, ensure_ascii=False,
                  indent=1)
    print('координаты пластин: %s' % os.path.relpath(PLATES, ROOT))


# --------------------------------------------------------------------------
# ШАГ 2: ЗАМЕР И ПАЛИТРА (снаружи Blender)
# --------------------------------------------------------------------------
def sample(path, cx, cy, r=3):
    import numpy as np
    from PIL import Image
    a = np.asarray(Image.open(path).convert('RGBA')).astype(float)
    h, w = a.shape[:2]
    box = a[max(0, cy - r):min(h, cy + r + 1), max(0, cx - r):min(w, cx + r + 1)]
    m = box[..., 3] > 250
    if not m.any():
        return None
    # 0..1, а не 0..255: дальше значение клампится и печатается как hex, и
    # разница единиц измерения дала бы «палитру» из семи чёрных цветов.
    return [float(v) / 255.0 for v in np.median(box[..., :3][m], axis=0)]


def build_palette():
    if not os.path.exists(PLATES):
        raise SystemExit('нет %s — сначала прогони шаг 1 в Blender'
                         % os.path.relpath(PLATES, ROOT))
    with open(PLATES, encoding='utf-8') as f:
        plates = json.load(f)
    paints = plates['paints']
    table = {}
    for c, item in sorted(plates['passes'].items()):
        for name, (cx, cy) in item['at'].items():
            rgb = sample(item['frame'], cx, cy)
            if rgb is None:
                raise SystemExit('пластина %s (c=%s) не попала в кадр (%d,%d)'
                                 % (name, c, cx, cy))
            table.setdefault(name, {})[c] = rgb

    tones = {}
    for name in paints:
        row = table[name]
        tones[name] = {}
        ks = sorted(float(k) for k in row)
        for band, c in BANDS:
            key = '%.2f' % c
            if key in row:
                rgb = row[key]
            else:
                lo = max([k for k in ks if k <= c] or [ks[0]])
                hi = min([k for k in ks if k >= c] or [ks[-1]])
                if hi == lo:
                    rgb = row['%.2f' % lo]
                else:
                    t = (c - lo) / (hi - lo)
                    rgb = [(1 - t) * row['%.2f' % lo][i]
                           + t * row['%.2f' % hi][i] for i in range(3)]
            tones[name][band] = '#%02X%02X%02X' % tuple(
                int(round(255.0 * max(0.0, min(1.0, v)))) for v in rgb)

    data = dict(
        _='ПАЛИТРА ДЕРЕВНИ: краски ратуши в кадре. Снята пробой '
          '(art/buildings/lumbercamp/tools/village_probe.py) — та же краска на '
          'фасетах с известными нормалями, канонная камера и свет. Тон light — '
          'грань в небо (косинус к солнцу 0.90), mid — на солнце (0.60), dark — '
          'в тень (0.30). Этой палитрой проверяется лагерь лесоруба: он красится '
          'краской ратуши, а не палитрой атласа природы.',
        version=1,
        source='art/buildings/townhall/tools/townhall.py :: palette()',
        probe=dict(sun=list(SUN_DIR), sun_energy=2.05,
                   ambient=[0.62, 0.66, 0.72], ambient_strength=0.42,
                   ppu=PPU, res=list(RES),
                   c=[float(x) for x in PROBE_C]),
        outline=['#0C100C', '#0D120D', '#0E130E', '#0B0F0B'],
        # Канон тени — общий для всей игры, а не деревенский: он снят с
        # эталонного атласа и от краски не зависит.  Скопирован из
        # `4tox-lowpoly-3d/references/palette.json` дословно (гейт читает его
        # из палитры, и без ключа `check_shadow` падает).
        shadow={'w_over_sil': [0.7, 2.0], 'h_over_w': [0.04, 0.4],
                'max_alpha': [0.25, 0.9], 'p90_alpha': [0.08, 0.7],
                'rgb': '#000000'},
        tones=tones,
        budget={'building': {'tris': [300, 1500], 'verts': [200, 800]}},
        probe_table=table,
    )
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    print('палитра деревни: %s (%d красок)'
          % (os.path.relpath(OUT, ROOT), len(tones)))
    for name in paints:
        print('   %-8s %s' % (name, '  '.join('%s %s' % (b, tones[name][b])
                                              for b, _ in BANDS)))
    return 0


def main():
    if IN_BLENDER:
        return render_pass()
    return build_palette()


if __name__ == '__main__':
    main()
