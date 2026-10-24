# -*- coding: utf-8 -*-
"""Плитка низкой травы для участков построек — чистая геометрия, без bpy.

Зачем своя плитка. Участок в игре — газон вокруг дома, а не частокол из
спрайтов `grass_tuft`: вплотную друг к другу те читаются кустами, а не травой
(на это и была жалоба заказчика). Здесь та же порода травы, но прижатая к
земле: короткие широкие листья, много плоских граней, тёмные щели между ними.
Цвет — тот же зелёный, что у карты, только на ступень темнее: газон не должен
спорить с лугов.

Плитка ПЕРИОДИЧЕСКАЯ. Внутри квадрата `tile x tile` листья раскладываются
джиттером по сетке; Blender ставит девять копий (3 x 3), поэтому всё, что
вылезло за край, продолжается с другой стороны без шва. Камера смотрит ровно
в центральный квадрат. Тон травы задаёт периодическое поле из синусов с
целыми частотами — пятна света и тени тоже сходятся на кромках.

Единицы — клетки карты, как у всех моделей 4tox: 1 юнит = 1 клетка, Z вверх.
Плитка = 2 x 2 клетки: столько же, сколько повторяется текстура земли
(`Renderer.TEX_REPEAT`), поэтому трава участка ложится в тот же масштаб.

Модуль не импортирует bpy: габарит, треугольники и палитру можно проверить
`python3 tools/grass_tile.py` за секунды, не поднимая Blender.
"""

import math
import random

# --- палитра (sRGB 0..255) ------------------------------------------------
# Снята с кустиков атласа и поднята к цвету луга: у спрайтов пиксели уходят
# в тень контура, а у поверхности такой тени нет. Доля зелёного к красному
# держится 1.40..1.46, синий — около 0.53 от зелёного: это тот же тон, что
# у карты, а не оливковый и не бирюзовый.
MATERIALS = {
    'ground':       (106, 168, 80),
    'leaf_deep':    (94, 152, 70),
    'leaf_mid':     (118, 180, 88),
    'leaf_light':   (140, 200, 104),
    'leaf_tip':     (158, 214, 116),
}

# Порядок слотов фиксирован: по нему сцена Blender раскладывает материалы.
MAT_ORDER = ['ground', 'leaf_deep', 'leaf_mid', 'leaf_light', 'leaf_tip']

TILE = 2.0
SEED = 20261024
TAU = math.tau


# --- мелочи ---------------------------------------------------------------

def _rot_z(x, y, a):
    ca, sa = math.cos(a), math.sin(a)
    return x * ca - y * sa, x * sa + y * ca


def _face_normal(poly):
    """Нормаль многоугольника по первым трём точкам (не единичная)."""
    ax, ay, az = poly[1][0] - poly[0][0], poly[1][1] - poly[0][1], poly[1][2] - poly[0][2]
    bx, by, bz = poly[2][0] - poly[0][0], poly[2][1] - poly[0][1], poly[2][2] - poly[0][2]
    return (ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx)


class _Mesh(object):
    def __init__(self):
        self.verts = []
        self.faces = []
        self.mats = []

    def add_face(self, pts, mat):
        """Добавляет грань, разворачивая её нормалью вверх."""
        n = _face_normal(pts)
        if n[2] < 0:
            pts = list(reversed(pts))
        base = len(self.verts)
        self.verts.extend(pts)
        self.faces.append(list(range(base, base + len(pts))))
        self.mats.append(mat)


# --- тон травы ------------------------------------------------------------

def grass_tone(x, y, tile):
    """Периодическое поле тона: пятна света и тени, а не шум по листу.

    Частоты целые относительно плитки, поэтому на стыке копий поле совпадает
    и «пятнистость» не обрывается.
    """
    v = (math.sin(TAU * 2.0 * x / tile + 0.9)
         + 0.65 * math.cos(TAU * 3.0 * y / tile + 0.35)
         + 0.35 * math.sin(TAU * 5.0 * (x + y) / tile + 2.1))
    if v < -0.52:
        return 'leaf_deep'
    if v > 0.64:
        return 'leaf_light'
    return 'leaf_mid'


def grass_wind(x, y, tile):
    """Периодическое поле направления: трава причёсана, но не под линейку.

    У луга на карте листья смотрят вразнобой; у газона есть общий поток, и
    именно он отличает траву от конфетти. Поле из синусов даёт плавные завитки
    и сходится на кромках плитки.
    """
    return (0.55 * math.sin(TAU * 2.0 * y / tile + 0.8)
            + 0.35 * math.cos(TAU * 3.0 * x / tile + 0.4)
            + 0.9)


# --- листья ---------------------------------------------------------------

def add_flat_leaf(mesh, rng, base, azimuth, length, width, ridge,
                  mat, z):
    """Лежачий широкий лист: две грани-ската, как у низкополигонального листа.

    Лист не плоская бумажка: вдоль центральной жилки он чуть поднят, поэтому
    левая и правая половины ловят свет по-разному. На 256 px/клетку это даёт
    ту самую игру фасетов, что у кустиков атласа, а не ровную зелёную заливку.
    """
    ax, ay = math.cos(azimuth), math.sin(azimuth)
    sx, sy = -ay, ax
    # лёгкий изгиб листа в сторону: кончик уходит с оси
    curve = rng.uniform(-0.22, 0.22) * length

    def P(t, side, lift):
        w = 0.5 * width * ((1.0 - t) ** 0.58)
        off = curve * math.sin(math.pi * t)
        return (base[0] + ax * length * t - ay * off + sx * side * w,
                base[1] + ay * length * t + ax * off + sy * side * w,
                z + lift)

    # Две половины-ската. Каждая половина — три ТРЕУГОЛЬНИКА, а не один
    # n-угольник: n-угольник с приподнятой жилкой не плоский, и Cycles
    # триангулирует его как попало — на этом уже были чёрные клинья в v1.
    o0l, o1l, o2 = P(0.0, -1.0, 0.0), P(0.55, -1.0, 0.0), P(1.0, 0.0, 0.0)
    r0, r1 = P(0.0, 0.0, ridge * 0.30), P(0.55, 0.0, ridge)
    o0r, o1r = P(0.0, 1.0, 0.0), P(0.55, 1.0, 0.0)
    mesh.add_face([o0l, o1l, r0], mat)
    mesh.add_face([o1l, r1, r0], mat)
    mesh.add_face([o1l, o2, r1], mat)
    mesh.add_face([o0r, r0, o1r], mat)
    mesh.add_face([o1r, r0, r1], mat)
    mesh.add_face([o1r, r1, o2], mat)


def add_blade(mesh, rng, base, azimuth, lean_deg, length, width,
              mat_body, mat_tip, segments=4, droop=0.08, sweep=0.0):
    """Короткий стоячий лист: лента, суженная к кончику.

    Он наклонён от основания наружу, поэтому сверху виден широкой гранью, а
    не палкой в один пиксель. Стоячих листьев немного: они дают тень и
    глубину, но газон держится на лежачем слое.
    """
    lean = math.radians(lean_deg)
    ax, ay = math.cos(azimuth), math.sin(azimuth)
    twist = rng.uniform(-0.35, 0.35)
    side_x, side_y = _rot_z(-ay, ax, twist)

    left = []
    right = []
    for i in range(segments):
        t = i / float(segments)
        h = math.sin(lean) * length * (t ** 1.10)
        z = (math.cos(lean) * length * t
             + 0.10 * length * math.sin(math.pi * t)
             - droop * length * t * t)
        so = sweep * length * t * t
        cx = base[0] + ax * h - ay * so
        cy = base[1] + ay * h + ax * so
        half = 0.5 * width * ((1.0 - t) ** 0.62)
        left.append((cx + side_x * half, cy + side_y * half, base[2] + max(0.0, z)))
        right.append((cx - side_x * half, cy - side_y * half, base[2] + max(0.0, z)))

    h = math.sin(lean) * length
    z = math.cos(lean) * length + 0.10 * length * math.sin(math.pi) - droop * length
    so = sweep * length
    tip = (base[0] + ax * h - ay * so, base[1] + ay * h + ax * so,
           base[2] + max(0.0, z))

    for i in range(segments - 1):
        t = i / float(segments)
        mat = mat_tip if t >= 0.64 else mat_body
        mesh.add_face([left[i], right[i], right[i + 1], left[i + 1]], mat)
    mesh.add_face([left[segments - 1], right[segments - 1], tip], mat_tip)


# --- вся плитка -----------------------------------------------------------

def add_tuft(mesh, rng, cx, cy, main_az, tone, z0):
    """Низкий кустик-веер: 6–10 коротких широких листьев в общем потоке.

    Это не «звезда» из прошлой версии: листья растут не из одной точки во все
    стороны, а веером вдоль потока травы. Поэтому кустик читается пучком
    подстриженной травы, а не цветком; вплотную такие пучки дают газон.
    """
    n = rng.randint(6, 10)
    for i in range(n):
        az = main_az + rng.uniform(-0.78, 0.78)
        bx = cx + rng.uniform(-0.038, 0.038)
        by = cy + rng.uniform(-0.038, 0.038)
        mat = tone
        r = rng.random()
        if r < 0.15:
            mat = 'leaf_deep'
        elif r > 0.86:
            mat = 'leaf_light'
        if rng.random() < 0.13:
            # один-два торчащих листа на кустик: тень и глубина
            add_blade(mesh, rng, (bx, by, 0.0024), az,
                      rng.uniform(32.0, 56.0), rng.uniform(0.060, 0.105),
                      rng.uniform(0.013, 0.024), mat, 'leaf_tip',
                      segments=4, sweep=rng.uniform(-0.05, 0.05))
        else:
            add_flat_leaf(mesh, rng, (bx, by), az,
                          rng.uniform(0.050, 0.105),
                          rng.uniform(0.018, 0.034),
                          rng.uniform(0.0012, 0.0024),
                          mat, z0 + rng.uniform(0.0, 0.0009))


def build(seed=SEED, tile=TILE):
    """Возвращает словарь: verts, faces, face_mats, tile, stats."""
    rng = random.Random(seed)
    mesh = _Mesh()

    # 1. Нижний ковёр: широкие лежачие листья в два тона (тёмный/средний),
    # без светлых кончиков. Он закрывает землю и держит общий тон, чтобы
    # газон не читался «кустиками на пустом месте».
    bgrid = 32
    bstep = tile / bgrid
    bi = 0
    for gy in range(bgrid):
        for gx in range(bgrid):
            cx = (gx + 0.5) * bstep + rng.uniform(-0.48, 0.48) * bstep
            cy = (gy + 0.5) * bstep + rng.uniform(-0.48, 0.48) * bstep
            mat = 'leaf_mid' if grass_tone(cx, cy, tile) != 'leaf_deep' else 'leaf_deep'
            add_flat_leaf(
                mesh, rng, (cx, cy),
                grass_wind(cx, cy, tile) + rng.uniform(-0.55, 0.55),
                rng.uniform(0.075, 0.145), rng.uniform(0.024, 0.042),
                rng.uniform(0.0010, 0.0022), mat,
                0.0004 + (bi % 180) * 0.000006)
            bi += 1

    # 2. Кустики поверх ковра: короткие веера в общем потоке. Они дают
    # «травинчатость», светлые кончики и тени, но уже не держат всю площадь.
    grid = 14
    step = tile / grid
    li = 0
    for gy in range(grid):
        for gx in range(grid):
            if rng.random() < 0.05:
                continue
            cx = (gx + 0.5) * step + rng.uniform(-0.46, 0.46) * step
            cy = (gy + 0.5) * step + rng.uniform(-0.46, 0.46) * step
            add_tuft(mesh, rng, cx, cy,
                     grass_wind(cx, cy, tile) + rng.uniform(-0.22, 0.22),
                     grass_tone(cx, cy, tile),
                     0.0016 + (li % 120) * 0.000008)
            li += rng.randint(6, 10)

    # 3. Одиночные листья в щелях: чтобы не оставалось ровных проплешин.
    for i in range(320):
        cx = rng.uniform(0.0, tile)
        cy = rng.uniform(0.0, tile)
        add_flat_leaf(
            mesh, rng, (cx, cy),
            grass_wind(cx, cy, tile) + rng.uniform(-0.6, 0.6),
            rng.uniform(0.055, 0.110), rng.uniform(0.019, 0.032),
            rng.uniform(0.0010, 0.0022),
            grass_tone(cx, cy, tile),
            0.0012 + rng.uniform(0.0, 0.0012))

    # --- статистика ------------------------------------------------------
    tris = sum(max(0, len(f) - 2) for f in mesh.faces)
    xs = [v[0] for v in mesh.verts]
    ys = [v[1] for v in mesh.verts]
    zs = [v[2] for v in mesh.verts]
    return {
        'tile': tile,
        'seed': seed,
        'verts': mesh.verts,
        'faces': mesh.faces,
        'face_mats': mesh.mats,
        'materials': dict(MATERIALS),
        'mat_order': list(MAT_ORDER),
        'stats': {
            'verts': len(mesh.verts),
            'faces': len(mesh.faces),
            'tris': tris,
            'leaf_flat': bi + li + 320,
            'blades_stand': int(grid * grid * 0.95 * 8 * 0.13),
            'bbox': [round(min(xs), 4), round(min(ys), 4), round(min(zs), 4),
                     round(max(xs), 4), round(max(ys), 4), round(max(zs), 4)],
        },
    }


if __name__ == '__main__':
    data = build()
    s = data['stats']
    print('плитка %.2f x %.2f клетки, seed %d' % (data['tile'], data['tile'], data['seed']))
    print('вершин %d, граней %d, треугольников %d' % (s['verts'], s['faces'], s['tris']))
    print('лежачих листьев %d, стоячих ~%d' % (s['leaf_flat'], s['blades_stand']))
    bb = s['bbox']
    print('габарит x: %.3f..%.3f  y: %.3f..%.3f  z: %.3f..%.3f'
          % (bb[0], bb[3], bb[1], bb[4], bb[2], bb[5]))
    print('палитра:', ', '.join('%s%s' % (k, v) for k, v in MATERIALS.items()))
