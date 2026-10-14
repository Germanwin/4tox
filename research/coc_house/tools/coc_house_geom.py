"""Геометрия дома в стиле Clash of Clans — чистый Python, без Blender.

Система координат: Z вверх, подошва на z = 0, дом стоит на (0, 0).
Фронтон смотрит в -Y, конёк идёт вдоль оси Y. 1 юнит = 1 клетка карты.

Наружу отдаётся список деталей:
    (name, material, verts, faces)   # verts: [(x,y,z)], faces: [(i,j,k,l)]
Сборкой в Blender занимается build_house.py.
"""
import math
import random

# ---------------------------------------------------------------- размеры
W_HX, W_HY = 1.55, 1.40          # полугабарит стен (3.10 x 2.80)
WALL_Z0, WALL_Z1 = 0.30, 2.20    # низ и верх стен
ROOF_EAVE_Z = 2.24               # низ кровли у свеса
ROOF_RIDGE_Z = 3.90              # конёк (подъём 1.66, уклон ~42°)
ROOF_HX = 1.85                   # полупролёт кровли по X (свес 0.30)
ROOF_HY = 1.66                   # полуглубина кровли по Y (свес 0.26)
ROOF_SLAB = 0.15                 # толщина кровельной плиты
ROOF_KINK = 0.20                 # доля подъёма, где меняется уклон
DOOR_HW = 0.52                   # полуширина дверного проёма
DOOR_SPRING = 1.86               # начало арки
WIN_W, WIN_H = 0.62, 0.62        # проём окна
WIN_Z = 1.38                     # центр окна
STONE_BLOCK_Z0 = 1.00            # ниже этого каменно-блочная облицовка не идёт

WIN_FRAMES = [
    ('front', -0.82, -W_HY, 0.0), ('front', 0.82, -W_HY, 0.0),
    ('back', -1.02, W_HY, 0.0), ('back', 0.0, W_HY, 0.0), ('back', 1.02, W_HY, 0.0),
    ('side', -W_HX, 0.0, math.pi / 2), ('side', W_HX, 0.0, -math.pi / 2),
]


# ---------------------------------------------------------------- утилиты
def merge(*groups):
    out = []
    for g in groups:
        out.extend(g)
    return out


def box_verts(hx, hy, hz):
    return [(sx * hx, sy * hy, sz * hz)
            for sx in (-1, 1) for sy in (-1, 1) for sz in (0, 1)]


BOX_FACES = [
    (0, 1, 3, 2),  # -X
    (4, 6, 7, 5),  # +X
    (0, 4, 5, 1),  # -Y
    (2, 3, 7, 6),  # +Y
    (0, 2, 6, 4),  # -Z
    (1, 5, 7, 3),  # +Z
]


def box(center, size, rot_z=0.0, rot_y=0.0):
    """Блок: center — центр по XY и НИЗ по Z, size — полные размеры."""
    cx, cy, z0 = center
    hx, hy, hz = size[0] * 0.5, size[1] * 0.5, size[2] * 0.5
    cz = z0 + hz
    cz_a, sz_a = math.cos(rot_z), math.sin(rot_z)
    cy_a, sy_a = math.cos(rot_y), math.sin(rot_y)
    verts = []
    for vx, vy, vz in box_verts(hx, hy, hz):
        x, y, z = vx, vy, vz
        if rot_y:
            x, z = x * cy_a + z * sy_a, -x * sy_a + z * cy_a
        if rot_z:
            x, y = x * cz_a - y * sz_a, x * sz_a + y * cz_a
        verts.append((cx + x, cy + y, cz + z))
    return verts, list(BOX_FACES)


def wall_pt(wall_x, wall_y, rot, u, n):
    """Точка у стены: u — вдоль стены, n — наружу от неё."""
    c, s = math.cos(rot), math.sin(rot)
    return (wall_x + u * c + n * s, wall_y + u * s - n * c)


def wall_box(center_u, center_z, size, n, rot, wall_x, wall_y):
    """Блок у стены: центр по (u, z), вынос наружу на n."""
    cx, cy = wall_pt(wall_x, wall_y, rot, center_u, n)
    return box((cx, cy, center_z - size[2] * 0.5), size, rot_z=rot)


# ---------------------------------------------------------------- крыша
def roof_profile():
    """Правая половина профиля (x >= 0): от свеса до конька."""
    rise = ROOF_RIDGE_Z - ROOF_EAVE_Z
    return [(ROOF_HX, ROOF_EAVE_Z),
            (ROOF_HX * (1.0 - ROOF_KINK), ROOF_EAVE_Z + ROOF_KINK * rise),
            (0.0, ROOF_RIDGE_Z)]


def z_on_slope(x, prof=None):
    """z верхней поверхности кровли при данном |x|."""
    prof = prof or roof_profile()
    x = min(abs(x), prof[0][0])
    for i in range(len(prof) - 1):
        x0, z0 = prof[i]
        x1, z1 = prof[i + 1]
        if x >= x1:
            return z0 + (z1 - z0) * (x0 - x) / (x0 - x1)
    return prof[-1][1]


def _offset_chain(pts, d):
    """Сместить ломаную внутрь на d, срезая углы (митры)."""
    out = []
    for i, (x, z) in enumerate(pts):
        if i == 0:
            nx, nz = 1.0, 0.0
        elif i == len(pts) - 1:
            nx, nz = 0.0, -1.0
        else:
            ax, az = pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]
            bx, bz = pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]
            la, lb = math.hypot(ax, az), math.hypot(bx, bz)
            na, nb = (-az / la, ax / la), (-bz / lb, bx / lb)
            sx, sz = na[0] + nb[0], na[1] + nb[1]
            ls = math.hypot(sx, sz) or 1.0
            nx, nz = sx / ls, sz / ls
        out.append((x + nx * d, z + nz * d))
    return out


def roof_slabs():
    """Две кровельные плиты: скаты к -X и к +X."""
    chain = list(reversed(roof_profile())) + _offset_chain(roof_profile(), ROOF_SLAB)
    parts = []
    for tag, pts in (('roof_negx', chain),
                     ('roof_posx', [(-x, z) for x, z in reversed(chain)])):
        verts, faces = [], []
        n = len(pts)
        for (x, z) in pts:
            verts.append((x, -ROOF_HY, z))
            verts.append((x, ROOF_HY, z))
        for i in range(n):
            a, b = i, (i + 1) % n
            faces.append((2 * a, 2 * b, 2 * b + 1, 2 * a + 1))
        for flip in (False, True):
            faces.append(tuple(2 * (n - 1 - i) if flip else 2 * i for i in range(n)))
        parts.append((tag, 'slate', verts, faces))
    return parts


def roof_details():
    """Капельники свесов (ветровые доски не ставим — см. ниже)."""
    parts = []
    # капельник вдоль свеса: короткий брус под кровельной плитой
    for sgn in (-1, 1):
        parts.append(('fascia_%d' % sgn, 'ridge') +
                     box((sgn * (ROOF_HX - 0.05), 0.0, 1.82),
                         (0.10, 2 * ROOF_HY - 0.06, 0.40)))
    # ветровые доски не ставим: ступенчатый фронтон сам держит силуэт,
    # а наклонные планки ложились не той плоскостью и давали светлые накладки
    return parts


# ---------------------------------------------------------------- стены
def wall_core():
    return [('wall_core', 'stone') + box((0, 0, WALL_Z0),
                                         (2 * W_HX, 2 * W_HY, WALL_Z1 - WALL_Z0))]


def _block_material(rng):
    return 'stone_lit' if rng.random() < 0.46 else 'stone'


def wall_relief():
    """Каменная облицовка стен: невысокий рельеф блоков, швы читаются тенью."""
    rng = random.Random(20261013)
    parts = []
    course = 0.30
    rows = int((WALL_Z1 - STONE_BLOCK_Z0) / course)
    sides = [('front', W_HX, -W_HY, -1.0), ('back', W_HX, W_HY, 1.0),
             ('left', W_HY, -W_HX, -1.0), ('right', W_HY, W_HX, 1.0)]
    for side, half, coord, sign in sides:
        for r in range(rows):
            z0 = STONE_BLOCK_Z0 + r * course
            width = 0.44 if r % 2 else 0.58
            u = -half + (r % 2) * 0.29
            while u < half - 0.04:
                w = min(width + rng.uniform(-0.05, 0.14), half - u)
                uc = u + w * 0.5
                if _door_overlap(side, uc, w):
                    u += w
                    continue
                depth = 0.052 + rng.uniform(-0.006, 0.008)
                size = ((w - 0.03, depth, course - 0.035) if side in ('front', 'back')
                        else (depth, w - 0.03, course - 0.035))
                p = ((uc, coord + sign * depth * 0.5, z0 + 0.018)
                     if side in ('front', 'back')
                     else (coord + sign * depth * 0.5, uc, z0 + 0.018))
                parts.append(('blk_%s_%d' % (side, r), _block_material(rng)) + box(p, size))
                u += w
    return parts


def _door_overlap(side, u_center, w):
    if side != 'front':
        return False
    return not (u_center + w * 0.5 < -0.88 or u_center - w * 0.5 > 0.88)


def corner_quoins():
    """Угловые камни: перевязка угла внахлёст."""
    parts = []
    z, row = STONE_BLOCK_Z0, 0
    while z < WALL_Z1 - 0.05:
        h = 0.30 if row % 2 == 0 else 0.26
        for sx in (-1, 1):
            for sy in (-1, 1):
                parts.append(('quoin_%d_%d_%d' % (row, sx, sy),
                              'stone_mid' if row % 2 else 'stone_lit') +
                             box((sx * (W_HX + 0.008), sy * (W_HY + 0.008), z),
                                 (0.40, 0.40, h - 0.028)))
        z += 0.30
        row += 1
    return parts


GABLE_WIN_W, GABLE_WIN_H = 0.44, 0.40
GABLE_WIN_Z = 2.92


def gable_window():
    """Слуховое окно во фронтоне: каменная обвязка, рама, тёплое стекло."""
    parts = []
    y = -ROOF_HY + 0.04
    z0 = GABLE_WIN_Z - GABLE_WIN_H * 0.5
    parts.append(('gwin_glass', 'glass') +
                 box((0, y + 0.03, z0), (GABLE_WIN_W, 0.08, GABLE_WIN_H)))
    for tag, x, z, size in (('lo', 0.0, z0 - 0.05, (GABLE_WIN_W + 0.34, 0.13, 0.10)),
                            ('hi', 0.0, z0 + GABLE_WIN_H + 0.02, (GABLE_WIN_W + 0.34, 0.13, 0.10)),
                            ('lf', -GABLE_WIN_W * 0.5 - 0.09, z0 - 0.03, (0.11, 0.13, GABLE_WIN_H + 0.10)),
                            ('rt', GABLE_WIN_W * 0.5 + 0.09, z0 - 0.03, (0.11, 0.13, GABLE_WIN_H + 0.10))):
        parts.append(('gwin_stone_' + tag, 'stone_lit') +
                     box((x, y - 0.005, z), size))
    parts.append(('gwin_mull', 'wood_dark') +
                 box((0, y - 0.02, z0), (0.05, 0.10, GABLE_WIN_H)))
    return parts


def ridge():
    """Коньковый брус: узкий, чтобы не спорил с кровлей."""
    return [('ridge_beam', 'ridge') + box((0, 0, ROOF_RIDGE_Z - 0.04),
                                          (0.30, 2 * ROOF_HY + 0.06, 0.10))]


def plinth():
    """Цоколь: два уступа, верх шире — дом «сидит» на камне."""
    return [('plinth_lo', 'stone_dark') +
            box((0, 0, 0.0), (2 * (W_HX + 0.16), 2 * (W_HY + 0.16), 0.15)),
            ('plinth_hi', 'stone_mid') +
            box((0, 0, 0.15), (2 * (W_HX + 0.09), 2 * (W_HY + 0.09), 0.15))]


# ---------------------------------------------------------------- фронтон
def gable_wedge():
    """Каменный клин фронтона; лицо — в плоскости торца кровли."""
    hz = 0.52
    top_z = WALL_Z1 + hz
    hx = W_HX * (ROOF_RIDGE_Z - top_z) / (ROOF_RIDGE_Z - WALL_Z1)
    depth = ROOF_HY - W_HY + 0.10
    parts = []
    for sy in (-1, 1):
        parts.append(('gable_wedge_%d' % sy, 'stone') +
                     box((0, sy * (ROOF_HY - depth * 0.5), WALL_Z1), (2 * hx, depth, hz)))
    return parts


def gable_steps():
    """Ступенчатая кладка фронтона, подрезанная под скат кровли."""
    parts = []
    z, row = WALL_Z1, 0
    limit = z_on_slope(W_HX) - 0.05
    while z < ROOF_RIDGE_Z - 0.28:
        z_top = min(z + 0.33, limit)
        if z_top - z < 0.10:
            break
        hx = min(W_HX * (ROOF_RIDGE_Z - z_top) / (ROOF_RIDGE_Z - WALL_Z1), W_HX)
        for sy in (-1, 1):
            parts.append(('gable_step_%d_%d' % (row, sy), _block_material(random.Random(row))) +
                         box((0, sy * (ROOF_HY - 0.06), z), (2 * hx, 0.12, z_top - z)))
        z += 0.33
        row += 1
    return parts


# ---------------------------------------------------------------- дверь
def door_surround():
    """Каменная арка из клиньев + косяки + плита порога."""
    parts = []
    n = 9
    r_in, r_out = DOOR_HW, DOOR_HW + 0.15
    y0, depth = -W_HY - 0.03, 0.19
    for i in range(n):
        a0, a1 = math.pi * i / n + 0.024, math.pi * (i + 1) / n - 0.024
        pts = []
        for a in (a0, a1):
            for rr in (r_in, r_out):
                pts.append((rr * math.cos(a), rr * math.sin(a)))
        verts = [(x, y0 - depth * 0.5, DOOR_SPRING + z) for x, z in pts]
        verts += [(x, y0 + depth * 0.5, DOOR_SPRING + z) for x, z in pts]
        quads = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1),
                 (1, 5, 7, 3), (2, 3, 7, 6), (0, 2, 6, 4)]
        mat = 'stone_lit' if i in (0, n - 1, n // 2) else 'stone_mid'
        parts.append(('door_arch_%d' % i, mat, verts, quads))
    for sgn in (-1, 1):
        parts.append(('door_jamb_%d' % sgn, 'stone_mid') +
                     box((sgn * (DOOR_HW + 0.075), y0 - 0.095, WALL_Z0),
                         (0.15, 0.19, DOOR_SPRING - WALL_Z0 + 0.02)))
    parts.append(('door_sill', 'stone_dark') +
                 box((0, -W_HY - 0.11, WALL_Z0), (1.58, 0.26, 0.09)))
    return parts


def door_leaf():
    """Полотно двери: доски, поперечины, кольцо-ручка."""
    parts = []
    y = -W_HY + 0.08
    z0, h = 0.42, DOOR_SPRING - 0.44
    for i in range(5):
        x = -DOOR_HW + 0.045 + i * (2 * DOOR_HW - 0.09) / 5.0 + 0.083
        parts.append(('door_plank_%d' % i, 'wood_lit' if i % 2 else 'wood') +
                     box((x, y, z0), (0.16, 0.09, h)))
    parts.append(('door_brace_lo', 'wood_dark') + box((0, y - 0.055, z0 + 0.10), (0.98, 0.06, 0.11)))
    parts.append(('door_brace_hi', 'wood_dark') + box((0, y - 0.055, z0 + h - 0.22), (0.98, 0.06, 0.11)))
    parts.append(('door_ring', 'metal') + box((0.30, y - 0.08, z0 + 0.50), (0.11, 0.08, 0.11)))
    return parts


# ---------------------------------------------------------------- окно
def _window_open(wall_x, wall_y, rot):
    """Окно: подоконник, светящееся стекло, рама, крестовина, ставни."""
    parts = []
    hw, hh = WIN_W * 0.5, WIN_H * 0.5
    z0 = WIN_Z - hh
    add = lambda name, mat, u, v, n, size: parts.append(
        (name, mat) + wall_box(u, v, size, n, rot, wall_x, wall_y))
    add('win_sill', 'stone_mid', 0.0, z0 - 0.035, 0.055, (WIN_W + 0.36, 0.30, 0.11))
    add('win_glass', 'glass', 0.0, WIN_Z, 0.010, (WIN_W, 0.10, WIN_H))
    for tag, u, v, size in (('lo', 0.0, z0 + 0.03, (WIN_W + 0.18, 0.085, 0.06)),
                            ('hi', 0.0, z0 + WIN_H - 0.03, (WIN_W + 0.18, 0.085, 0.06)),
                            ('lf', -hw + 0.03, WIN_Z, (0.06, 0.085, WIN_H + 0.06)),
                            ('rt', hw - 0.03, WIN_Z, (0.06, 0.085, WIN_H + 0.06))):
        add('win_frame_' + tag, 'wood', u, v, 0.035, size)
    add('win_mull_v', 'wood_dark', 0.0, WIN_Z, 0.030, (0.05, 0.09, WIN_H))
    add('win_mull_h', 'wood_dark', 0.0, WIN_Z, 0.030, (WIN_W, 0.09, 0.05))
    for sgn in (-1, 1):
        add('win_shutter_%d' % sgn, 'wood_dark', sgn * (hw + 0.19), WIN_Z, 0.028,
            (0.30, 0.06, WIN_H + 0.06))
    return parts


def windows():
    parts = []
    for _, a, b, rot in WIN_FRAMES:
        parts += _window_open(a, b, rot)
    return parts


# ---------------------------------------------------------------- крыльцо
def steps():
    """Три ступени со щекой по бокам: вынесены вперёд, чтобы читались."""
    parts = []
    for i, z0 in enumerate((0.0, 0.10, 0.20)):
        y_front = -W_HY - 0.60 + i * 0.17
        parts.append(('step_%d' % i, 'stone_mid' if i % 2 else 'stone_lit') +
                     box((0, y_front + 0.085, z0), (1.30, 0.17, 0.10)))
    for sgn in (-1, 1):
        parts.append(('step_cheek_%d' % sgn, 'stone_dark') +
                     box((sgn * 0.72, -W_HY - 0.30, 0.0), (0.18, 0.62, 0.30)))
    return parts


def lantern():
    """Фонарь у двери: кронштейн, корпус, огонь."""
    parts = []
    x, y = -1.00, -W_HY - 0.06
    parts.append(('lant_arm', 'metal') + box((x, y - 0.09, 1.70), (0.06, 0.20, 0.06)))
    parts.append(('lant_top', 'metal') + box((x, y - 0.19, 1.70), (0.28, 0.28, 0.055)))
    parts.append(('lant_glow', 'glass') + box((x, y - 0.19, 1.55), (0.18, 0.18, 0.17)))
    for sx in (-1, 1):
        for sy in (-1, 1):
            parts.append(('lant_post_%d_%d' % (sx, sy), 'metal') +
                         box((x + sx * 0.11, y - 0.19 + sy * 0.11, 1.49), (0.045, 0.045, 0.23)))
    parts.append(('lant_bot', 'metal') + box((x, y - 0.19, 1.44), (0.26, 0.26, 0.055)))
    return parts


# ---------------------------------------------------------------- двор
def _barrel(cx, cy, n=12, scale=1.0):
    """Бочка: 12-гранная клёпка с двумя обручами."""
    parts = []
    rings = [(0.0, 0.225), (0.02, 0.275), (0.28, 0.29), (0.54, 0.27), (0.58, 0.225)]
    verts, faces = [], []
    for z, r in rings:
        for i in range(n):
            a = 2 * math.pi * i / n + math.pi / n
            verts.append((cx + scale * r * math.cos(a), cy + scale * r * math.sin(a),
                          scale * z))
    for k in range(len(rings) - 1):
        for i in range(n):
            a, b = k * n + i, k * n + (i + 1) % n
            faces.append((a, b, b + n, a + n))
    faces.append(tuple(range(n - 1, -1, -1)))
    faces.append(tuple(range((len(rings) - 1) * n, len(rings) * n)))
    parts.append(('barrel_%d_%d' % (int(cx * 100), int(cy * 100)), 'wood_lit', verts, faces))
    for z0 in (0.12, 0.42):
        verts, faces = [], []
        for zz in (z0, z0 + 0.075):
            for i in range(n):
                a = 2 * math.pi * i / n + math.pi / n
                verts.append((cx + scale * 0.295 * math.cos(a),
                              cy + scale * 0.295 * math.sin(a), scale * zz))
        for i in range(n):
            a, b = i, (i + 1) % n
            faces.append((a, b, b + n, a + n))
        faces.append(tuple(range(n - 1, -1, -1)))
        faces.append(tuple(range(n, 2 * n)))
        parts.append(('barrel_band_%d_%d_%d' % (int(cx * 100), int(cy * 100), int(z0 * 100)),
                      'metal_dark', verts, faces))
    return parts


def barrels():
    return _barrel(1.00, -1.62, scale=1.0) + _barrel(-1.22, 1.56, scale=0.78)


def path():
    """Каменная дорожка от крыльца — плиты вразнобой."""
    parts = []
    slabs = [(0.04, -2.32, 0.58, 0.40), (-0.06, -2.74, 0.52, 0.36),
             (0.05, -3.12, 0.46, 0.32)]
    for i, (x, y, w, d) in enumerate(slabs):
        parts.append(('path_%d' % i, 'stone_mid' if i % 2 else 'stone_lit') +
                     box((x, y, 0.02), (w, d, 0.055)))
    return parts


def chimney():
    """Печная труба из камня на дальнем скате: прорезает кровлю, с оголовком."""
    cx, cy = -0.72, 0.34
    z_lo, z_hi = 2.78, 4.02
    parts = [('chimney', 'stone_mid') + box((cx, cy, z_lo), (0.44, 0.46, z_hi - z_lo))]
    # перевязка кладки трубы
    z = z_lo + 0.26
    row = 0
    while z < z_hi - 0.20:
        w = 0.50 if row % 2 == 0 else 0.40
        parts.append(('chimney_block_%d' % row, _block_material(random.Random(row + 40))) +
                     box((cx, cy, z), (w, 0.48 if row % 2 else 0.42, 0.22)))
        z += 0.28
        row += 1
    parts.append(('chimney_cap', 'stone_dark') + box((cx, cy, z_hi), (0.58, 0.60, 0.10)))
    parts.append(('chimney_cap2', 'stone_dark') + box((cx, cy, z_hi + 0.10), (0.48, 0.50, 0.07)))
    parts.append(('chimney_flue', 'metal_dark') + box((cx, cy, z_hi + 0.17), (0.30, 0.32, 0.05)))
    return parts


def plant():
    """Вьюн у заднего угла дома: стебель и листовые комки."""
    parts = []
    x0, y0 = -W_HX - 0.09, W_HY + 0.09
    parts.append(('plant_stem', 'wood_dark') + box((x0, y0, 0.34), (0.09, 0.09, 1.34)))
    clumps = [(0.44, 0.19), (0.72, 0.23), (1.02, 0.20), (1.28, 0.16), (1.54, 0.18)]
    rng = random.Random(7)
    for i, (z, r) in enumerate(clumps):
        parts.append(('plant_leaf_%d' % i, 'leaf' if i % 2 else 'leaf_lit') +
                     box((x0 + rng.uniform(-0.06, 0.06), y0 + rng.uniform(-0.05, 0.05), z),
                         (0.40, 0.38, r * 2)))
    return parts


def fence():
    """Короткая изгородь слева от крыльца: два столба и две перекладины."""
    parts = []
    for i, x in enumerate((-1.16, -1.72)):
        parts.append(('fence_post_%d' % i, 'wood_dark') +
                     box((x, -1.92, 0.0), (0.14, 0.14, 0.84)))
        parts.append(('fence_cap_%d' % i, 'ridge') +
                     box((x, -1.92, 0.84), (0.20, 0.20, 0.07)))
    for i, z in enumerate((0.26, 0.56)):
        parts.append(('fence_rail_%d' % i, 'wood') +
                     box((-1.44, -1.92, z), (0.72, 0.09, 0.11)))
    return parts


def ground():
    """Земляная подушка: неровный диск, темнее к краю."""
    rng = random.Random(11)
    n = 26
    verts = []
    for i in range(n):
        a = 2 * math.pi * i / n
        r = 3.55 + rng.uniform(-0.24, 0.28)
        verts.append((r * math.cos(a), r * math.sin(a), -0.03))
    verts.append((0.0, 0.0, -0.03))
    faces = [(i, (i + 1) % n, n) for i in range(n)]
    return [('ground', 'grass', verts, faces)]


def build():
    return merge(ground(), plinth(), wall_core(), wall_relief(), corner_quoins(),
                 gable_wedge(), gable_steps(), gable_window(), steps(),
                 door_surround(), door_leaf(), windows(), lantern(), path(),
                 barrels(), plant(), fence(), chimney(), ridge(), roof_slabs(),
                 roof_details())


if __name__ == '__main__':
    ps = build()
    tris = sum(len(f) - 2 for p in ps for f in p[3])
    print('деталей: %d, треугольников: %d' % (len(ps), tris))
    mats = {}
    for p in ps:
        mats[p[1]] = mats.get(p[1], 0) + 1
    for k in sorted(mats):
        print('  %-12s %d' % (k, mats[k]))
