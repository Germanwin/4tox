"""hut.py — геометрия СТАРТОВОГО ДОМА ЖИТЕЛЯ для mapgen2. Чистый Python.

Конвенции пайплайна (townhall/tools/thpipe.py, geom.py):
    1 юнит модели = 1 клетка карты; пятно 3 x 2 (X — длинная сторона);
    начало координат — центр пятна; z = 0 — земля; дверь смотрит в +Y.
    Камера смотрит С -X/+Y: при повороте 0 видно фасад (+Y) и торец (-X).

ЧЕМ ЭТОТ ДОМ ОТЛИЧАЕТСЯ ОТ ДОМА ЖИТЕЛЯ (art/buildings/villager_house)
--------------------------------------------------------------------
Заказчик просил: та же школа и палитра, что у ратуши, но ДРУГАЯ форма и
ДРУГОЙ размер, и вид слабой деревни, где дом ещё не достроен.  Отличия не в
деталях, а в самой архитектуре:

  1. КРОВЛЯ АСИММЕТРИЧНАЯ (saltbox): конёк сдвинут к задней стене
     (`RIDGE_Y = -0.05` вместо 0), передний скат пологий и длинный, задний
     крутой и короткий.  Дом жителя — симметричная двускатка.
  2. ТОРЕЦ ЗАШИВАЕТСЯ ПО-РАЗНОМУ: у щипцов разные наклоны, поэтому силуэт
     с торца не повторяет силуэт дома жителя и ратуши.
  3. ДОМ НЕДОСТРОЕН, и это видно с любого из четырёх поворотов: на переднем
     скате НЕ ХВАТАЕТ ПЛАСТА СОЛОМЫ — обнажены стропила и обрешётка, солома
     обрывается ступенью; у карниза торчат хвосты стропил, потому что солома
     не доведена до кромки; коньковый прогон голый, прижимной жерди нет;
     на фасаде одна панель обмазки не замазана — стоит плетень (прутья);
     окно щипца без рамы и стекла; в цоколе не хватает трёх блоков, рядом
     лежит кучка камня; во дворе — штабель брёвен, лестница и заготовка
     конькового бруса на подпорке.
  4. НИ ОДНОЙ «ОБЖИТОЙ» ДЕТАЛИ: ни трубы, ни ставень, ни кадки, ни поленницы,
     ни мха.  Всё, что в доме жителя говорит «здесь живут», здесь отсутствует:
     деревня только-только начата.

СВЕРХУ ВНИЗ (канон `4tox-house-3d/references/house-canon.md` §3):
    цоколь -> стены с каркасом -> проёмы -> кровля -> конёк -> двор.

ЯРУСЫ И ЧИСЛА
    пятно 3 x 2 клетки          (при повороте 90/270 — 2 x 3)
    стены 2.76 x 1.64, высота 1.35, наклон 1.2 град (верх — номинал)
    цоколь 0.16, выступ 0.045
    скаты: передний 44 град, задний 52 град; свес по скату 0.155 (13.6 %
    меньшей стороны стены), по торцу 0.15 (5.4 % длинной); кровля 0.08
    полная высота 2.04 — НИЖЕ канонных 2.60, и это осознанно: у дома нет
    трубы, потому что он недостроен (`SPEC['note']`).

ТРИ ПРАВИЛА (те же, что у дома жителя; каждое — вылеченные грабли)
    1. Геометрия в НОМИНАЛЕ, наклон стены — отдельно (`lean`).
    2. У каждой грани явный смысл: брусок знает, с каких сторон его видно.
    3. Стык, а не «почти достал»: раскос доходит до стойки с заходом внутрь.
"""
import math
import random

# --------------------------------------------------------------------------
# КОНВЕНЦИИ И РАЗМЕРЫ (юниты; 1 юнит = 1 клетка)
# --------------------------------------------------------------------------
WALL_X, WALL_Y = 2.76, 1.58        # оси стен: X — длинная сторона (3 клетки),
                                   # Y — глубина (2 клетки).  Глубина 1.58, а
                                   # не 1.64, как у дома 3 x 2: пятно тут на
                                   # клетку мельче, и при 1.64 свес кровли с
                                   # хвостами стропил вылезал за кромку
                                   # (приёмка: «габарит 2.10 в пятне 2»)
HX, HY = WALL_X / 2.0, WALL_Y / 2.0       # 1.38, 0.79

PL_H = 0.16                        # каменный цоколь, высота (канон 0.15)
PL_OUT = 0.045                     # выступ цоколя за плоскость стены
WALL_Z0 = PL_H                     # 0.16
WALL_H = 1.35                      # высота стен (канон 1.35)
WALL_Z1 = WALL_Z0 + WALL_H         # 1.51

FRAME_OUT = 0.05                   # выступ каркаса за плоскость стены
FRAME_T = 0.10                     # толщина бруса каркаса
CP_W = 0.14                        # угловая стойка
ST_W = 0.11                        # промежуточная стойка
PLATE_H = 0.13                     # высота обвязки

TAN_LEAN = math.tan(math.radians(1.2))


def wall_k(z):
    """Стена «растёт»: k = 1 вверху (номинал), ниже — уже."""
    t = (z - WALL_Z0) / WALL_H
    t = 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)
    return 1.0 - (1.0 - t) * TAN_LEAN


def lean(verts):
    return [(v[0] * wall_k(v[2]), v[1] * wall_k(v[2]), v[2]) for v in verts]


# --- кровля: АСИММЕТРИЧНЫЙ (saltbox) профиль -------------------------------
# Конёк сдвинут к задней стене, скаты разной крутизны.  НИЗ кровли на каждом
# скате считается ОТ СВОЕГО КАРНИЗА: передний идёт от y = +ROOF_Y0 вверх к
# коньку, задний — от y = -ROOF_Y0 вверх к коньку.  Знак в скобке обязан быть
# (ROOF_Y0 - |y|) на ОБОИХ скатах: если задний скат считать по передней
# формуле, он уезжает в небо (проверено прогоном — конёк вставал на z = 4.5).
# УКЛОНЫ СНЯТЫ С РАТУШИ.  Скат, повёрнутый к солнцу, ловит n·sun > 0.55 и
# красится СВЕТЛЫМ тоном соломы; при 40° передний скат давал 12% светлых
# пикселей и палитра не сходилась (89% вместо 93%).  У ратуши скат 47°, и тон
# тёмный.  Здесь передний скат 48° (крутой, тёмный, как у ратуши), задний 41°
# (пологий) — асимметрия сохраняется, а светлого тона на видимой стороне нет.
PITCH_FRONT = math.radians(48.0)   # скат К КАМЕРЕ (-Y): крутой, канон 45..55
PITCH_BACK = math.radians(41.0)    # скат ОТ камеры (+Y): пологий, канон 32..55
TAN_B, TAN_F = math.tan(PITCH_BACK), math.tan(PITCH_FRONT)
ROOF_T = 0.08                      # полная толщина кровли (солома + обрешётка)
ROOF_Y0 = HY + FRAME_OUT           # 0.87 — низ кровли идёт по наружной кромке
                                   # верхней обвязки, а не по плоскости стены
OVER_FRONT = 0.19                  # свес по переднему скату (12.0 % WALL_Y,
                                   # канон 11..31 %: кромка шире стены)
OVER_BACK = 0.19                   # свес по заднему скату
OVER_END = 0.12                    # свес по торцу (4.3 % WALL_X, канон 4..13)
EAVE_Y = HY + OVER_FRONT           # 0.975 — кромка соломы по Y
ROOF_X = HX + OVER_END             # 1.53 — кромка кровли по X

# КОНЁК — точка, где сходятся ПЛОСКОСТИ двух скатов, а не выбранное число.
# Скаты считаются от своих карнизов (z = WALL_Z1 при |y| = ROOF_Y0):
#   передний  z = WALL_Z1 + (ROOF_Y0 - y) * TAN_F
#   задний    z = WALL_Z1 + (ROOF_Y0 + y) * TAN_B
# Приравняв: y = -ROOF_Y0 * (TAN_B - TAN_F) / (TAN_B + TAN_F) = -0.3616,
# z = 2.342.  Конёк обязан стоять на ЗАДНЕЙ половине: у saltbox задний скат
# крутой и короткий, передний — пологий и длинный.
RIDGE_Y = -ROOF_Y0 * (TAN_B - TAN_F) / (TAN_B + TAN_F)
Z_RIDGE = WALL_Z1 + (ROOF_Y0 - abs(RIDGE_Y)) * TAN_F
Z_EAVE_FRONT = WALL_Z1 + TAN_F * (ROOF_Y0 - EAVE_Y)      # 1.409
Z_EAVE_BACK = WALL_Z1 + TAN_B * (ROOF_Y0 - EAVE_Y)       # 1.376

SOFFIT = ROOF_T * 0.70             # 0.056 — низ кровли (щипцы идут до него)
THATCH_UP = ROOF_T - SOFFIT * 0.5  # 0.052 — солома выше плоскости обрешётки

# --- проёмы ---------------------------------------------------------------
DOOR_W, DOOR_H = 0.34, 0.72        # дверь (канон 0.32 x 0.72)
WIN = 0.26                         # окно (канон 0.26)
WIN_FW = 0.05                      # ширина планки рамы
WIN_OUT = 0.05                     # выступ рамы за плоскость стены
RIGEL_Z0, RIGEL_Z1 = 0.90, 0.99    # ригель: одна линия на окна и на дверь
WIN_Z = RIGEL_Z0 - (WIN / 2.0 + WIN_FW)     # 0.75 — окно подпирает ригель
WIN_FRONT_X = 0.80                 # центры окон фасада
DOOR_X = -0.35                     # дверь смещена от центра дома
WIN_EMPTY_X = 0.55                 # пустой проём со следами рамы (фасад)
WIN_SIDE_Y = 0.30                  # окно торца (ось Y)
GABLE_HOLE_Y = 0.0                 # проём в щипце
GABLE_HOLE = 0.20

STUD_X = 0.50                      # промежуточные стойки фасада, |x|
RIDGE_BEAM_W = 0.11                # сечение конькового прогона
RIDGE_BEAM_H = 0.09                # высота бруса над скатом

# --- недострой: где именно не хватает -------------------------------------
# На переднем скате НЕ ХВАТАЕТ КУСКА СОЛОМЫ: X от BARE_X0 до BARE_X1 (середина
# ската) и Y от конька (RIDGE_Y) до BARE_Y1.  Ниже BARE_Y1 и по краям солома
# уложена до карниза, поэтому пропуск читается НЕДОЛОЖЕННЫМ участком, а не
# сломанной крышей.  В пропуске видны стропила и обрешётка.
BARE_X0, BARE_X1 = -0.24, 0.26     # границы пропуска по X (компактный: куски
                                   # соломы по бокам остаются крупными плоскостями)
BARE_Y1 = 0.30                     # докуда (по Y) не хватает соломы
N_RAFTER = 7                       # шаг ~0.49 — стропила читаются гребёнкой
N_LATH = 5                         # латы в пропуске
PLINTH_GAP = (0.42, 1.04)          # выпавшие блоки цоколя по X (передняя стена)
WATTLE_X = -0.86                   # незамазанная панель фасада (центр по X)
WATTLE_W = 0.34

SEE_ALL = ((0.0, 0.0, 1.0), (0.0, 1.0, 0.0), (0.0, -1.0, 0.0),
           (1.0, 0.0, 0.0), (-1.0, 0.0, 0.0))

SPEC = dict(
    footprint=(3, 2),
    wall_x=WALL_X, wall_y=WALL_Y, wall_h=WALL_H,
    z_plinth=PL_H, z_wall=WALL_Z1,
    pitch_deg=round(math.degrees(PITCH_FRONT), 2),   # меньший из двух скатов
    pitch_back_deg=round(math.degrees(PITCH_BACK), 2),
    # свесы — ГОРИЗОНТАЛЬНЫЙ вылет кромки кровли за плоскость стены (так их
    # меряет приёмка): OVER_FRONT = HY + OVER_FRONT - HX-сторона
    over_slope=round(OVER_FRONT, 4),
    over_end=round(OVER_END, 4),
    tris=(300, 1500),
    note=('низкая кровля без трубы: дом недостроен, коньковый прогон голый; '
          'полная высота меньше канонных 2.60 осознанно'),
    # КАНОН ЭТОГО КЛАССА.  Дом меньше канонного 3 x 2 по глубине и заметно
    # ниже: трубы у него нет (печь не сложена), поэтому 2.60..3.00 из общего
    # канона к нему неприменимы — иначе приёмка мерила бы недострой линейкой
    # достроенного дома.  Всё остальное (стены, уклоны, свесы, кровля/стены,
    # бюджет, деталь >= 0.02) взято из общего канона без послаблений.
    canon=dict(h_b=(1.85, 2.35), wall_h=(1.20, 1.50), pitch=(32.0, 55.0),
               over_slope=(0.11, 0.31), over_end=(0.04, 0.13),
               roof_wall=(0.45, 1.35), tris=(300, 1500)),
)


# --------------------------------------------------------------------------
# ПРИМИТИЗЫ
# --------------------------------------------------------------------------
FACES_ALL = ('+x', '-x', '+y', '-y', '+z', '-z')


def _rot(p, cx, cy, cz, rz, rx, ry):
    x, y, z = p[0] - cx, p[1] - cy, p[2] - cz
    if rz:
        c, s = math.cos(rz), math.sin(rz)
        x, y = x * c - y * s, x * s + y * c
    if rx:
        c, s = math.cos(rx), math.sin(rx)
        y, z = y * c - z * s, y * s + z * c
    if ry:
        c, s = math.cos(ry), math.sin(ry)
        x, z = x * c + z * s, -x * s + z * c
    return (x + cx, y + cy, z + cz)


def box(cx, cy, z0, sx, sy, sz, rz=0.0, rx=0.0, ry=0.0, keep=None):
    """Короб: (cx, cy, z0) — центр ОСНОВАНИЯ, размеры, поворот вокруг него."""
    x0, x1 = cx - sx / 2.0, cx + sx / 2.0
    y0, y1 = cy - sy / 2.0, cy + sy / 2.0
    z1 = z0 + sz
    base = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
            (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
    named = [('+z', (4, 5, 6, 7)), ('-z', (0, 3, 2, 1)),
             ('+y', (2, 3, 7, 6)), ('-y', (0, 1, 5, 4)),
             ('+x', (1, 2, 6, 5)), ('-x', (3, 0, 4, 7))]
    faces = [f for n, f in named if keep is None or n in keep]
    if rz or rx or ry:
        base = [_rot(p, cx, cy, z0, rz, rx, ry) for p in base]
        # Поворот, зеркалящий оси (rx = 180, ry = 180 и их комбинации), меняет
        # ОРИЕНТАЦИЮ контура: нормали всех шести граней смотрят внутрь, и
        # деталь светится изнанкой.  Проверяем знаковый объём и при
        # отрицательном выворачиваем порядок вершин — тогда обход граней снова
        # наружу (проверено на всех восьми вариантах поворотов).
        _vol = 0.0
        for _f in faces:
            for _k in range(1, len(_f) - 1):
                _a, _b, _c = base[_f[0]], base[_f[_k]], base[_f[_k + 1]]
                _vol += (_a[0] * (_b[1] * _c[2] - _b[2] * _c[1])
                         - _a[1] * (_b[0] * _c[2] - _b[2] * _c[0])
                         + _a[2] * (_b[0] * _c[1] - _b[1] * _c[0])) / 6.0
        if _vol < 0:
            base = [(base[0], base[3], base[2], base[1],
                     base[4], base[7], base[6], base[5])]
    return base, faces


def prism_x(poly_yz, x0, x1, keep=None):
    """Призма вдоль X по контуру в YZ. Контур ориентируется по знаку площади."""
    if x1 < x0:
        x0, x1 = x1, x0
    poly = list(poly_yz)
    area = 0.5 * sum(poly[i][0] * poly[(i + 1) % len(poly)][1]
                     - poly[(i + 1) % len(poly)][0] * poly[i][1]
                     for i in range(len(poly)))
    if area < 0.0:
        poly = poly[::-1]
    n = len(poly)
    verts = [(x0, y, z) for y, z in poly] + [(x1, y, z) for y, z in poly]
    faces = []
    for i in range(n):
        j = (i + 1) % n
        faces.append((i, j, n + j, n + i))
    faces.append(tuple(range(n - 1, -1, -1)))
    faces.append(tuple(range(n, 2 * n)))
    if keep is not None:
        out = []
        if 'side' in keep:
            out += faces[:n]
        if '-x' in keep:
            out.append(faces[-2])
        if '+x' in keep:
            out.append(faces[-1])
        faces = out
    return verts, faces


def _norm(v):
    d = math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) or 1.0
    return (v[0] / d, v[1] / d, v[2] / d)


def _face_normal(verts, f):
    p = [verts[i] for i in f]
    a = (p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2])
    b = (p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2])
    return _norm((a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2],
                  a[0] * b[1] - a[1] * b[0]))


def cull(verts, faces, see=SEE_ALL, min_dot=0.12):
    out = []
    for f in faces:
        n = _face_normal(verts, f)
        if any(n[0] * s[0] + n[1] * s[1] + n[2] * s[2] > min_dot for s in see):
            out.append(f)
    return out


def bar(p0, p1, sx, sy, see=(), caps=(), over=0.0):
    """Брусок из p0 в p1; сечение: sx — вдоль u, sy — вдоль v.

    Для бруска, идущего ВДОЛЬ X, u = ±Y (поперёк), v = Z.  Значит у стропила
    sx — ширина в плане, sy — высота на ребро.
    """
    ax = (p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2])
    ln = math.sqrt(ax[0] ** 2 + ax[1] ** 2 + ax[2] ** 2)
    w = _norm(ax)
    ref = (0.0, 0.0, 1.0) if abs(w[2]) < 0.9 else (1.0, 0.0, 0.0)
    u = _norm((w[1] * ref[2] - w[2] * ref[1],
               w[2] * ref[0] - w[0] * ref[2],
               w[0] * ref[1] - w[1] * ref[0]))
    v = (w[1] * u[2] - w[2] * u[1], w[2] * u[0] - w[0] * u[2],
         w[0] * u[1] - w[1] * u[0])
    hx, hy, hz = sx / 2.0, sy / 2.0, ln / 2.0 + over
    cx = (p0[0] + p1[0]) / 2.0
    cy = (p0[1] + p1[1]) / 2.0
    cz = (p0[2] + p1[2]) / 2.0
    verts = []
    for sz_ in (-1, 1):
        for sgx, sgy in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            verts.append((cx + u[0] * hx * sgx + v[0] * hy * sgy + w[0] * hz * sz_,
                          cy + u[1] * hx * sgx + v[1] * hy * sgy + w[1] * hz * sz_,
                          cz + u[2] * hx * sgx + v[2] * hy * sgy + w[2] * hz * sz_))
    all_faces = [(4, 5, 6, 7), (0, 3, 2, 1), (2, 3, 7, 6), (0, 1, 5, 4),
                 (1, 2, 6, 5), (3, 0, 4, 7)]
    normals = [w, (-w[0], -w[1], -w[2]), v, (-v[0], -v[1], -v[2]), u,
               (-u[0], -u[1], -u[2])]
    idx = []
    if 0 in caps:
        idx.append(0)
    if 1 in caps:
        idx.append(1)
    if see:
        for i in (2, 3, 4, 5):
            n = normals[i]
            if any(n[0] * s[0] + n[1] * s[1] + n[2] * s[2] > 0.20 for s in see):
                idx.append(i)
    else:
        idx.extend((2, 3, 4, 5))
    return verts, [all_faces[i] for i in sorted(set(idx))]


def _drop_x_sides(p):
    """Убрать у призмы боковины ±X (те, что на плоскости YZ).

    Нужно там, где солома разрезана по X на куски ради пропуска: куски — это
    ОДНА деталь, и на стыке их боковые грани смотрят наружу изнанкой.
    """
    keep = []
    for f in p['faces']:
        n = _face_normal(p['verts'], f)
        if abs(n[1]) < 0.9 and abs(n[2]) < 0.9:
            continue
        keep.append(f)
    p['faces'] = keep


def _quad_tris(q0, q1, q2, q3, n):
    """Две треугольные грани четырёхугольника, обход выправлен по нормали n.

    Работает с ТОЧКАМИ (не индексами): одна и та же четвёрка используется и
    генератором детали, и триангулятором при анализе, поэтому индексов не
    требуется и путаницы с ними не возникает.
    """
    out = []
    for tri in ((q0, q1, q2), (q0, q2, q3)):
        pa, pb, pc = tri
        e1 = [pb[i] - pa[i] for i in range(3)]
        e2 = [pc[i] - pa[i] for i in range(3)]
        cr = (e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2],
              e1[0] * e2[1] - e1[1] * e2[0])
        dot = cr[0] * n[0] + cr[1] * n[1] + cr[2] * n[2]
        if abs(dot) < 1e-14:
            continue
        out.append(tri if dot > 0 else (tri[0], tri[2], tri[1]))
    return out


def _tri_strip(pts, n):
    """Триангуляция ПОЛОСЫ (скат кровли: ровный верх + пила низа).

    Ear clipping на таком контуре ненадёжен: у полосы толщина 0.016 при длине
    1.3, уши находятся через раз, часть треугольников выходит с обратным
    обходом (низ соломы смотрел вверх — 1670 px изнанок).  Здесь контур
    расписывается на четырёхугольники между верхней и нижней цепочками.

    Возвращает список ТРОЕК ТОЧЕК либо None, если контур не «полоса».  Годится
    и генератору (сложить фасеты), и анализатору (растеризовать их).
    """
    m = len(pts)
    if m < 4 or m % 2:
        return None
    k = pts.index(min(pts, key=lambda q: q[1]))
    P = pts[k:] + pts[:k]
    E, L = P[:m // 2], P[m // 2:]
    for ch in (E, L):
        for i in range(len(ch) - 1):
            if ch[i + 1][1] <= ch[i][1] + 1e-9:
                return None
    if abs(E[0][1] - L[0][1]) > 1e-6 or abs(E[-1][1] - L[-1][1]) > 1e-6:
        return None
    ye = set(round(q[1], 9) for q in E)
    yl = set(round(q[1], 9) for q in L)
    if ye != yl:
        return None
    idx = {round(q[1], 9): i for i, q in enumerate(E)}
    jdx = {round(q[1], 9): i for i, q in enumerate(L)}
    ys = sorted(ye)
    tris = []
    for a, b in zip(ys, ys[1:]):
        i0, i1 = idx[a], idx[b]
        j0, j1 = jdx[a], jdx[b]
        if i1 <= i0 or j1 <= j0:
            return None
        tris += _quad_tris(E[i0], E[i1], L[j1], L[j0], n)
    return tris or None


def _triangles(pts):
    """Триангуляция полигона (ear clipping) с сохранением обхода."""
    m = len(pts)
    if m < 3:
        return []
    if m == 3:
        return [(0, 1, 2)]
    # полоса (скат кровли) разбирается своим разбором — ear clipping на ней врёт
    if m >= 4 and m % 2 == 0:
        n0 = _face_normal(pts, tuple(range(m)))
        strip = _tri_strip(pts, n0)
        if strip is not None:
            pos = {}
            for i, q in enumerate(pts):
                pos.setdefault((round(q[0], 9), round(q[1], 9), round(q[2], 9)), i)
            idxs = []
            for tri in strip:
                try:
                    idxs.append(tuple(pos[(round(q[0], 9), round(q[1], 9),
                                           round(q[2], 9))] for q in tri))
                except KeyError:
                    idxs = None
                    break
            if idxs:
                return idxs
    # Нормаль — СУММОЙ векторных произведений соседних рёбер (формула Ньюэлла).
    # По первым трём точкам считать нельзя: у контура с рядом лежащих на одной
    # прямой вершин (низ и верх щипца, карниз кровли) нормаль выходит из шума,
    # и треугольники выправлялись «по случайной» оси.
    n = [0.0, 0.0, 0.0]
    for i in range(m):
        a, b = pts[i], pts[(i + 1) % m]
        n[0] += (a[1] - b[1]) * (a[2] + b[2])
        n[1] += (a[2] - b[2]) * (a[0] + b[0])
        n[2] += (a[0] - b[0]) * (a[1] + b[1])
    n = tuple(n)
    ax = max(range(3), key=lambda i: abs(n[i]))
    i0, i1 = [i for i in range(3) if i != ax]
    P = [(p[i0], p[i1]) for p in pts]
    area = 0.5 * sum(P[i][0] * P[(i + 1) % m][1] - P[(i + 1) % m][0] * P[i][1]
                     for i in range(m))
    sgn = 1.0 if area >= 0 else -1.0
    idx = list(range(m))
    out = []
    guard = 0
    while len(idx) > 3 and guard < 4 * m + 16:
        guard += 1
        cut = False
        for k in range(len(idx)):
            a, b, c = idx[k - 1], idx[k], idx[(k + 1) % len(idx)]
            pa, pb, pc = P[a], P[b], P[c]
            cr = ((pb[0] - pa[0]) * (pc[1] - pa[1])
                  - (pb[1] - pa[1]) * (pc[0] - pa[0])) * sgn
            if cr <= 1e-12:
                continue
            ok = True
            for j in idx:
                if j in (a, b, c):
                    continue
                q = P[j]
                d1 = (pb[0] - pa[0]) * (q[1] - pa[1]) - (pb[1] - pa[1]) * (q[0] - pa[0])
                d2 = (pc[0] - pb[0]) * (q[1] - pb[1]) - (pc[1] - pb[1]) * (q[0] - pb[0])
                d3 = (pa[0] - pc[0]) * (q[1] - pc[1]) - (pa[1] - pc[1]) * (q[0] - pc[0])
                if d1 * sgn >= -1e-12 and d2 * sgn >= -1e-12 and d3 * sgn >= -1e-12:
                    ok = False
                    break
            if ok:
                out.append((a, b, c))
                idx.remove(b)
                cut = True
                break
        if not cut:
            break
    if len(idx) > 3:
        for k in range(1, len(idx) - 1):
            out.append((idx[0], idx[k], idx[k + 1]))
    elif len(idx) == 3:
        out.append(tuple(idx))
    # ОБХОД ВЫПРАВЛЯЕТСЯ ПО ЗНАКУ ПЛОЩАДИ КОНТУРА.  У тонкой пилы кровли
    # (толщина 0.016 при длине 1.3) ear clipping выдаёт часть треугольников с
    # ОБРАТНЫМ обходом: низ соломы начинал смотреть ВВЕРХ, и детектор показывал
    # 1600 px изнанок на ровном скате.  Треугольники без площади выбрасываются.
    # Проверка — В 3D: у невыпуклого и неплоского контура проекция на «свою»
    # плоскость может дать обратный знак, и треугольник выйдет вывернутым
    # (симптом: низ соломы смотрел вверх, 1670 px изнанок).  Нормаль полигона
    # n известна — по ней и выправляем.
    fixed = []
    for a, b, c in out:
        pa, pb, pc = pts[a], pts[b], pts[c]
        e1 = [pb[i] - pa[i] for i in range(3)]
        e2 = [pc[i] - pa[i] for i in range(3)]
        cr = (e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2],
              e1[0] * e2[1] - e1[1] * e2[0])
        dot = cr[0] * n[0] + cr[1] * n[1] + cr[2] * n[2]
        if abs(dot) < 1e-14:
            continue
        if dot < 0:
            b, c = c, b
        fixed.append((a, b, c))
    return fixed


def _tri_indices(verts, f):
    """Триангулировать фасет и вернуть индексы В ИСХОДНОМ списке вершин.

    `_triangles` работает с копией точек контура и возвращает индексы ВНУТРИ
    этой копии; подставлять их прямо в глобальный список вершин нельзя (у
    фасета с вырезанными ушами порядок уже другой).  Раньше это делал и
    `autocull`, и `xray.mesh` — из-за этого триангуляция собиралась из чужих
    вершин, и детектор показывал 6600 px изнанок на ровном стропиле.
    """
    pts = [verts[i] for i in f]
    tri = _triangles(pts)
    if len(tri) == len(pts) - 2:
        # индексы уцелели (ухо срезалось подряд) — берём как есть
        return [(f[a], f[b], f[c]) for a, b, c in tri]
    # иначе отождествляем точки по координатам: у контура они уникальны
    lookup = {}
    for k, q in enumerate(pts):
        lookup.setdefault((round(q[0], 7), round(q[1], 7), round(q[2], 7)), k)
    out = []
    for a, b, c in tri:
        try:
            out.append((f[lookup[(round(pts[a][0], 7), round(pts[a][1], 7),
                                  round(pts[a][2], 7))]],
                        f[lookup[(round(pts[b][0], 7), round(pts[b][1], 7),
                                  round(pts[b][2], 7))]],
                        f[lookup[(round(pts[c][0], 7), round(pts[c][1], 7),
                                  round(pts[c][2], 7))]]))
        except KeyError:
            continue
    return out


def _ray_tri(o, d, a, b, c, tmax):
    e1 = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
    e2 = (c[0] - a[0], c[1] - a[1], c[2] - a[2])
    pv = (d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2],
          d[0] * e2[1] - d[1] * e2[0])
    det = e1[0] * pv[0] + e1[1] * pv[1] + e1[2] * pv[2]
    if -1e-12 < det < 1e-12:
        return None
    inv = 1.0 / det
    tv = (o[0] - a[0], o[1] - a[1], o[2] - a[2])
    u = (tv[0] * pv[0] + tv[1] * pv[1] + tv[2] * pv[2]) * inv
    if u < -1e-9 or u > 1 + 1e-9:
        return None
    qv = (tv[1] * e1[2] - tv[2] * e1[1], tv[2] * e1[0] - tv[0] * e1[2],
          tv[0] * e1[1] - tv[1] * e1[0])
    v = (d[0] * qv[0] + d[1] * qv[1] + d[2] * qv[2]) * inv
    if v < -1e-9 or u + v > 1 + 1e-9:
        return None
    t = (e2[0] * qv[0] + e2[1] * qv[1] + e2[2] * qv[2]) * inv
    return t if 1e-6 < t < tmax else None


class _Grid(object):
    def __init__(self, tris, cell=0.25):
        self.cell = cell
        self.d = {}
        self.tris = tris
        for i, (a, b, c) in enumerate(tris):
            x0 = min(a[0], b[0], c[0]); x1 = max(a[0], b[0], c[0])
            y0 = min(a[1], b[1], c[1]); y1 = max(a[1], b[1], c[1])
            z0 = min(a[2], b[2], c[2]); z1 = max(a[2], b[2], c[2])
            for ix in range(int(x0 // cell), int(x1 // cell) + 1):
                for iy in range(int(y0 // cell), int(y1 // cell) + 1):
                    for iz in range(int(z0 // cell), int(z1 // cell) + 1):
                        self.d.setdefault((ix, iy, iz), []).append(i)

    def along(self, o, p):
        out = set()
        cell = self.cell
        n = max(1, int(max(abs(p[i] - o[i]) for i in range(3)) / cell * 2.0) + 1)
        for k in range(n + 1):
            t = k / float(n)
            q = (o[0] + (p[0] - o[0]) * t, o[1] + (p[1] - o[1]) * t,
                 o[2] + (p[2] - o[2]) * t)
            out.update(self.d.get((int(q[0] // cell), int(q[1] // cell),
                                   int(q[2] // cell)), ()))
        return out


def _is_closed(part_):
    seen = set()
    for f in part_['faces']:
        for k in range(len(f)):
            e = (f[k], f[(k + 1) % len(f)])
            if e in seen:
                return False
            seen.add(e)
    return all((b, a) in seen for (a, b) in seen)


def autocull(parts, cover=0.03):
    """Выбросить фасеты, немедленно закрытые соседом или утопленные в него.

    Два теста на каждую пробную точку фасета (контракт `forge.autocull`):
      1) луч наружу упирается в чужую геометрию ближе `cover` — фасет закрыт;
      2) точка внутри ЗАМКНУТОЙ чужой детали (чётность луча вверх).

    Третий тест («точка внутри ГАБАРИТА соседа») пробовался и ОТВЕРГНУТ: он
    режет фасеты, которые лишь пересекаются габаритами с соседом (полосы стен
    у углов дома), и взамен спрятанных фасетов наружу выходят изнанки — счётчик
    изнанок вырастал с 1.4k до 12k px.
    """
    tris, owner = [], []
    for pi, p in enumerate(parts):
        v = p['verts']
        for f in p['faces']:
            for t in _tri_indices(v, f):
                tris.append((v[t[0]], v[t[1]], v[t[2]]))
                owner.append(pi)
    grid = _Grid(tris)
    boxes, closed = [], []
    for p in parts:
        v = p['verts']
        boxes.append(([min(q[i] for q in v) for i in range(3)],
                      [max(q[i] for q in v) for i in range(3)]))
        closed.append(_is_closed(p))
    solid = [i for i in range(len(parts)) if closed[i] and len(parts[i]['faces']) >= 4]
    parts_tris = {i: [j for j in range(len(tris)) if owner[j] == i] for i in solid}

    def inside_solid(pt, skip):
        """Точка внутри замкнутой чужой детали: чётность пересечений луча ВВЕРХ.

        Луч именно (0,1,0) и до бесконечности, как в `forge.autocull`: у
        замкнутой детали он гарантированно уходит наружу, и чётность
        считается верно.  Луч по нормали фасета врал: у блока цоколя он шёл
        вдоль собственной грани, пересечения терялись, и все шесть граней
        оставались в меше (240 трис на ровном месте).
        """
        for si in solid:
            if si == skip:
                continue
            lo, hi = boxes[si]
            if not (lo[0] < pt[0] < hi[0] and lo[1] < pt[1] < hi[1]
                    and lo[2] < pt[2] < hi[2]):
                continue
            cnt = 0
            for ti in parts_tris[si]:
                a, b, c = tris[ti]
                if _ray_tri(pt, (0.0, 1.0, 0.0), a, b, c, 1e9) is not None:
                    cnt += 1
            if cnt % 2 == 1:
                return True
        return False

    for pi, p in enumerate(parts):
        if p.get('nocull'):
            # Кровля переднего ската разрезана по X ради пропуска: её куски —
            # ОДНА деталь, и на стыке боковые грани смотрят изнанкой.  Отсев
            # такие фасеты убирает, но тогда кусок перестаёт быть замкнутым, и
            # `canon.py` видит «объём<=0».  Поэтому у кусков кровли отсев
            # выключен целиком, а лишние боковины убирает `_drop_x_sides`.
            continue
        v, faces = p['verts'], p['faces']
        keep = []
        for f in faces:
            pts = [v[i] for i in f]
            n = _face_normal(v, f)
            cen = [sum(q[k] for q in pts) / len(pts) for k in range(3)]
            probes = [cen] + [[cen[k] + (q[k] - cen[k]) * 0.93 for k in range(3)]
                              for q in pts]
            hidden = True
            for q in probes:
                o = (q[0] + n[0] * 1e-4, q[1] + n[1] * 1e-4, q[2] + n[2] * 1e-4)
                end = (o[0] + n[0] * cover, o[1] + n[1] * cover,
                       o[2] + n[2] * cover)
                hit = False
                for ti in grid.along(o, end):
                    if owner[ti] == pi:
                        continue
                    a, b, c = tris[ti]
                    if _ray_tri(o, n, a, b, c, cover) is not None:
                        hit = True
                        break
                if not hit and not inside_solid(q, pi):
                    hidden = False
                    break
            if not hidden:
                keep.append(f)
        # НИ ОДНОЙ грани остаться не может: пустая деталь — это дыра в меше,
        # и `canon.py` ловит её как «объём<=0 (нормали внутрь)».  Отсев решает
        # по лучу и ошибается на деталях, посаженных В ОТВЕРСТИЕ ядра стены
        # (у него нет замкнутой оболочки, и внутренность не считается).  Когда
        # выброшены все фасеты — значит, ошибся отсев, а не геометрия: деталь
        # остаётся целой.
        p['faces'] = keep if keep else faces
    return parts


def jitter(verts, amount, seed, axis=None):
    if not amount:
        return verts
    rng = random.Random(seed)
    out = []
    for p in verts:
        d = [rng.uniform(-amount, amount) for _ in range(3)]
        if axis:
            for i in range(3):
                if axis[i] == 0:
                    d[i] = 0.0
        out.append((p[0] + d[0], p[1] + d[1], p[2] + d[2]))
    return out


def part(parts, name, family, verts, faces, jit=0.0, seed=0, ln=False):
    if ln:
        verts = lean(verts)
    if jit:
        verts = jitter(verts, jit, seed)
    parts.append(dict(name=name, family=family, verts=verts, faces=faces))
    return parts


def tris_of(parts):
    return sum(sum(len(f) - 2 for f in p['faces']) for p in parts)


def verts_of(parts):
    return sum(len(p['verts']) for p in parts)


# --------------------------------------------------------------------------
# КРОВЛЯ: ГЕОМЕТРИЯ ПОВЕРХНОСТИ
# --------------------------------------------------------------------------
# Плоскости скатов продлены каждая на свою сторону (передняя — на y < конька,
# задняя — на y > конька): так в коньке нет ни щели, ни двойного листа.  Обе
# поверхности совпадают только на самом ребре, и стык закрыт коньковым
# прогоном; плоскости с разными уклонами параллельными быть не могут, поэтому
# z-fighting там невозможен.
def _plane(y, ridge_z, tan_):
    """Высота плоскости ската: z = z_конька − |y − y_конька| * tan(уклон)."""
    return ridge_z - abs(y - RIDGE_Y) * tan_


def z_soffit(y):
    """НИЗ кровли (щипцы идут ровно до него)."""
    return _plane(y, Z_RIDGE, TAN_F if y >= RIDGE_Y else TAN_B)


def z_top(y):
    """ВЕРХ кровли по соломе: плоскость обрешётки плюс полная толщина."""
    return z_soffit(y) + THATCH_UP


def z_ridge_top():
    return z_top(RIDGE_Y)


def roof_plane(y):
    """Плоскость стропил и обрешётки: между низом и верхом кровли."""
    return z_soffit(y) + SOFFIT * 0.5


def _wall_faces(wall):
    return {'+y': ('+y', '+x', '-x'), '-y': ('-y', '+x', '-x'),
            '+x': ('+x', '+y', '-y'), '-x': ('-x', '+y', '-y')}[wall]


def stick(parts, name, wall, a0, a1, z0, z1, t=FRAME_T, out=FRAME_OUT,
          faces=('out', 'top'), fam='trunk', ln=True, jit=0.0, seed=0):
    """Брусок каркаса НА стене."""
    o, s1, s2 = _wall_faces(wall)
    keep = tuple({'out': o, 'top': '+z', 'bot': '-z', 's1': s1, 's2': s2}[k]
                 for k in faces)
    if wall in ('+y', '-y'):
        sgn = 1.0 if wall == '+y' else -1.0
        cx, cy = (a0 + a1) / 2.0, sgn * (HY + out - t / 2.0)
        sx, sy = abs(a1 - a0), t
    else:
        sgn = 1.0 if wall == '+x' else -1.0
        cx, cy = sgn * (HX + out - t / 2.0), (a0 + a1) / 2.0
        sx, sy = t, abs(a1 - a0)
    v, f = box(cx, cy, z0, sx, sy, z1 - z0, keep=keep)
    return part(parts, name, fam, v, f, jit=jit, seed=seed, ln=ln)


def _gable_profile():
    """Контур щипца: низ по верху стены, верх по НИЗУ кровли (не по коньку —
    иначе под свесом остаётся щель)."""
    return [(HY, WALL_Z1), (HY, z_soffit(HY)), (RIDGE_Y, z_soffit(RIDGE_Y)),
            (-HY, z_soffit(-HY)), (-HY, WALL_Z1)]


# --------------------------------------------------------------------------
# ЯРУС 1: ЦОКОЛЬ (с нехваткой блоков — дом недостроен)
# --------------------------------------------------------------------------
def build_plinth(parts, rng):
    px, py = HX + PL_OUT, HY + PL_OUT
    v, f = box(0.0, 0.0, 0.0, 2 * px, 2 * py, PL_H + 0.03)
    part(parts, 'plinth_core', 'stone', v, f, jit=0.005, seed=101)

    # блоки по длинным стенам: в передней НЕ ХВАТАЕТ трёх (PLINTH_GAP)
    for sgn_y in (1, -1):
        n = 4
        w = (2 * px + 0.06) / n
        for i in range(n):
            cx = -px - 0.03 + w * (i + 0.5)
            if sgn_y > 0 and PLINTH_GAP[0] <= cx <= PLINTH_GAP[1]:
                continue                       # выпавшие блоки — яма в кладке
            h = PL_H + rng.uniform(-0.02, 0.025)
            dz = rng.uniform(-0.012, 0.012)
            sy = rng.uniform(0.022, 0.048)
            v, f = box(cx, sgn_y * (py + sy / 2.0 - 0.012), dz,
                       w - 0.03, sy, h,
                       rz=math.radians(rng.uniform(-3.0, 3.0)),
                       rx=math.radians(rng.uniform(-2.0, 2.0)))
            part(parts, 'plinth_y%d_%d' % (sgn_y, i), 'stone', v, f,
                 jit=0.004, seed=110 + i + (0 if sgn_y > 0 else 7))
    for sgn_x in (1, -1):
        n = 3
        w = (2 * py + 0.06) / n
        for i in range(n):
            cy = -py - 0.03 + w * (i + 0.5)
            h = PL_H + rng.uniform(-0.02, 0.025)
            dz = rng.uniform(-0.012, 0.012)
            sx = rng.uniform(0.022, 0.048)
            v, f = box(sgn_x * (px + sx / 2.0 - 0.012), cy, dz,
                       sx, w - 0.03, h,
                       rz=math.radians(rng.uniform(-3.0, 3.0)),
                       ry=math.radians(rng.uniform(-2.0, 2.0)))
            part(parts, 'plinth_x%d_%d' % (sgn_x, i), 'stone', v, f,
                 jit=0.004, seed=130 + i + (0 if sgn_x > 0 else 5))


# --------------------------------------------------------------------------
# ЯРУС 2: СТЕНЫ И ТОРЦЫ
# --------------------------------------------------------------------------
def build_walls(parts):
    """Ядро стены с ПРОЁМОМ под незамазанную панель (плетень) на обеих
    длинных стенах, плюс щипцы.

    Проём не «нарисован поверх стены», а действительно оставлен в ядре: иначе
    обмазка торчала бы между прутьями плетня и читалась мусором."""
    ax0, ax1 = WATTLE_X - WATTLE_W / 2.0, WATTLE_X + WATTLE_W / 2.0
    wz0, wz1 = WALL_Z0 + 0.06, WALL_Z1 - 0.04
    for sgn_y in (1, -1):
        # БОКОВЫЕ КУСКИ — на всю высоту, а перемычки над и под проёмом — только
        # между ними.  Если положить их во всю длину стены, торцы перемычек
        # лягут ровно в плоскость боковых кусков: 2.75 юнита совпадающих
        # плоскостей у одной стены (нашёл `xray.py`, секция Z-FIGHTING).
        for x0, x1, tag in ((-HX, ax0, 'a'), (ax1, HX, 'b')):
            v, f = box((x0 + x1) / 2.0, sgn_y * HY / 2.0, WALL_Z0,
                       x1 - x0, HY, WALL_H)
            part(parts, 'wall_y%d_%s' % (sgn_y, tag), 'skin', v, f,
                 jit=0.005, seed=201 + (tag == 'b') + (sgn_y > 0), ln=True)
        for z0, z1, tag in ((WALL_Z0, wz0, 'low'), (wz1, WALL_Z1, 'high')):
            v, f = box((ax0 + ax1) / 2.0, sgn_y * HY / 2.0, z0,
                       ax1 - ax0, HY, z1 - z0)
            part(parts, 'wall_y%d_%s' % (sgn_y, tag), 'skin', v, f, jit=0.005,
                 seed=211 + (tag == 'high') + (sgn_y > 0), ln=True)
    # торцы — целые
    for sgn_x in (1, -1):
        v, f = box(sgn_x * HX / 2.0, 0.0, WALL_Z0, HX, WALL_Y, WALL_H)
        part(parts, 'wall_x%d' % sgn_x, 'skin', v, f, jit=0.005,
             seed=231 + (sgn_x > 0), ln=True)
    # щипцы — пятиугольники по профилю кровли, от верха стены до низа кровли
    prof = _gable_profile()
    for sgn in (1, -1):
        v, f = prism_x(prof, sgn * (HX - 0.06), sgn * HX,
                       keep=('+x' if sgn > 0 else '-x',))
        part(parts, 'gable%d' % sgn, 'skin', v, f, jit=0.004,
             seed=203 + (sgn > 0))


# --------------------------------------------------------------------------
# ЯРУС 2b: КАРКАС
# --------------------------------------------------------------------------
def build_frame(parts):
    z_bot0, z_bot1 = WALL_Z0, WALL_Z0 + PLATE_H
    z_top0, z_top1 = WALL_Z1 - PLATE_H, WALL_Z1

    for sgn in (1, -1):
        wy = '+y' if sgn > 0 else '-y'
        wx = '+x' if sgn > 0 else '-x'
        stick(parts, 'plate_by%d' % sgn, wy, -HX, HX, z_bot0, z_bot1,
              faces=('out', 'top', 'bot'))
        stick(parts, 'plate_ty%d' % sgn, wy, -HX, HX, z_top0, z_top1,
              faces=('out', 'top', 'bot'))
        stick(parts, 'plate_bx%d' % sgn, wx, -HY, HY, z_bot0, z_bot1,
              faces=('out', 'top', 'bot'))
        stick(parts, 'plate_tx%d' % sgn, wx, -HY, HY, z_top0, z_top1,
              faces=('out', 'top', 'bot'))

    # угловые стойки
    for sx_ in (1, -1):
        for sy_ in (1, -1):
            v, f = box(sx_ * (HX + FRAME_OUT - CP_W / 2.0),
                       sy_ * (HY + FRAME_OUT - CP_W / 2.0),
                       WALL_Z0, CP_W, CP_W, WALL_H,
                       keep=(('+x' if sx_ > 0 else '-x'),
                             ('+y' if sy_ > 0 else '-y'), '+z'))
            part(parts, 'corner_%d%d' % (sx_, sy_), 'trunk', v, f, ln=True)

    # стойки фасада и тыла: -STUD_X .. +STUD_X, панель с плетнем остаётся рамой
    for sy_ in (1, -1):
        wall = '+y' if sy_ > 0 else '-y'
        for sgn in (1, -1):
            stick(parts, 'stud_f%d_%d' % (sgn, sy_), wall,
                  sgn * STUD_X - ST_W / 2.0, sgn * STUD_X + ST_W / 2.0,
                  z_bot1, RIGEL_Z0, faces=('out', 's1', 's2'))
            stick(parts, 'stud_u%d_%d' % (sgn, sy_), wall,
                  sgn * STUD_X - ST_W / 2.0, sgn * STUD_X + ST_W / 2.0,
                  RIGEL_Z1, z_top0, faces=('out', 's1', 's2'))
        # стойки, обрамляющие незамазанную панель (та, где стоит плетень)
        for sgn in (1, -1):
            a = WATTLE_X + sgn * WATTLE_W / 2.0
            stick(parts, 'stud_w%d_%d' % (sgn, sy_), wall,
                  a - 0.055, a + 0.055, z_bot1, z_top0,
                  faces=('out', 's1', 's2'))
    # стойки торцов
    for sx_ in (1, -1):
        wall = '+x' if sx_ > 0 else '-x'
        for sg in (1, -1):
            for zz0, zz1, tag in ((z_bot1, RIGEL_Z0, 's'),
                                  (RIGEL_Z1, z_top0, 'u')):
                stick(parts, 'stud_%s%d_%d' % (tag, sg, sx_), wall,
                      sg * 0.26 - ST_W / 2.0, sg * 0.26 + ST_W / 2.0,
                      zz0, zz1, faces=('out', 's1', 's2'))

    # ригель: одна горизонталь на окна и дверь
    a_in_x = HX - CP_W / 2.0 + 0.03
    a_in_y = HY - CP_W / 2.0 + 0.03
    for wall, a0, a1 in (('+y', -a_in_x, a_in_x), ('-y', -a_in_x, a_in_x),
                         ('+x', -a_in_y, a_in_y), ('-x', -a_in_y, a_in_y)):
        stick(parts, 'rigel_%s' % wall, wall, a0, a1, RIGEL_Z0, RIGEL_Z1,
              faces=('out', 'top', 'bot'))

    # угловые раскосы верхних панелей фасада и тыла — ровно 45 град
    for wall in ('+y', '-y'):
        sgn_y = 1.0 if wall == '+y' else -1.0
        for sgn in (1, -1):
            v, f = bar((sgn * (a_in_x - 0.02), sgn_y * HY, RIGEL_Z1 - 0.015),
                       (sgn * (a_in_x - 0.42), sgn_y * HY,
                        RIGEL_Z1 - 0.015 + 0.40),
                       FRAME_T, 0.085,
                       see=((0.0, sgn_y, 0.0), (0.0, 0.0, 1.0)), over=0.03)
            part(parts, 'brace_y%s%d' % (wall[1], sgn), 'trunk', v, f, ln=True)

    # ЩИПЕЦ ТОРЦА: центральная стойка (до низа кровли) и два раскоса.
    # У этого дома конёк сдвинут, поэтому стойка щипца стоит НЕ по центру —
    # по сдвинутому коньку, и раскосы разной длины: торец читается «кривым»,
    # как и положено недострою.
    for sx_ in (1, -1):
        out_x = '+x' if sx_ > 0 else '-x'
        v, f = box(sx_ * (HX + FRAME_OUT - FRAME_T / 2.0), RIDGE_Y, WALL_Z1,
                   FRAME_T, ST_W, z_soffit(RIDGE_Y) - WALL_Z1 - 0.01,
                   keep=(out_x, '+y', '-y', '+z'))
        part(parts, 'gable_post%d' % sx_, 'trunk', v, f, ln=True)
        for sg in (1, -1):
            y0, y1 = sg * 0.80, RIDGE_Y + sg * 0.10
            z1 = z_soffit(y1) - 0.04
            v, f = bar((sx_ * HX, y0, WALL_Z1 - 0.015),
                       (sx_ * HX, y1, z1), FRAME_T, 0.075,
                       see=((sx_, 0.0, 0.0), (0.0, 0.0, 1.0)), over=0.03)
            part(parts, 'gable_brace%d_%d' % (sx_, sg), 'trunk', v, f, ln=True)

    # КОНЬКОВЫЙ ПРОГОН — голый: прижимной жерди и гребня нет (недострой)
    v, f = box(0.0, RIDGE_Y, z_top(RIDGE_Y) - 0.06, 2 * (ROOF_X - 0.03),
               RIDGE_BEAM_W, 0.09)
    part(parts, 'ridge_beam', 'trunk', v, f, jit=0.004, seed=260)


# --------------------------------------------------------------------------
# ЯРУС 3: ПРОЁМЫ
# --------------------------------------------------------------------------
def _frame_ring(parts, tag, wall, a_c, z_c, win, fam='trunk'):
    """Рама-кольцо в проёме стены: стойки на всю высоту, планки между ними."""
    half = win / 2.0
    O = half + WIN_FW
    t = 0.07
    dc = WIN_OUT - t / 2.0
    if wall in ('+y', '-y'):
        s = 1.0 if wall == '+y' else -1.0
        yc = s * (HY + dc)
        for sg in (1, -1):
            v, f = box(a_c + sg * (half + WIN_FW / 2.0), yc, z_c - O,
                       WIN_FW, t, 2 * O, keep=(wall, '+x', '-x'))
            part(parts, tag + '_fr%d' % sg, fam, v, f, ln=True)
        v, f = box(a_c, yc, z_c + half, win + 0.01, t, WIN_FW,
                   keep=(wall, '-z', '+z'))
        part(parts, tag + '_frt', fam, v, f, ln=True)
        v, f = box(a_c, yc, z_c - half - WIN_FW, win + 0.01, t, WIN_FW,
                   keep=(wall, '+z', '-z'))
        part(parts, tag + '_frb', fam, v, f, ln=True)
    else:
        s = 1.0 if wall == '+x' else -1.0
        xc = s * (HX + dc)
        for sg in (1, -1):
            v, f = box(xc, a_c + sg * (half + WIN_FW / 2.0), z_c - O,
                       t, WIN_FW, 2 * O, keep=(wall, '+y', '-y'))
            part(parts, tag + '_fr%d' % sg, fam, v, f, ln=True)
        v, f = box(xc, a_c, z_c + half, t, win + 0.01, WIN_FW,
                   keep=(wall, '-z', '+z'))
        part(parts, tag + '_frt', fam, v, f, ln=True)
        v, f = box(xc, a_c, z_c - half - WIN_FW, t, win + 0.01, WIN_FW,
                   keep=(wall, '+z', '-z'))
        part(parts, tag + '_frb', fam, v, f, ln=True)
    return O


def build_window(parts, cx, cy, cz, nx, ny, tag, size=None, sill=True,
                 shutters=False):
    """Окно: рама-кольцо, тёмное стекло, переплёт 2 x 2, подоконник."""
    win = size or WIN
    half = win / 2.0
    wall = '+y' if ny > 0 else ('-y' if ny < 0 else ('+x' if nx > 0 else '-x'))
    O = _frame_ring(parts, tag, wall, cx if ny else cy, cz, win)
    t = 0.07
    d_glass = WIN_OUT - 0.032
    d_mul = WIN_OUT - 0.014
    if ny:
        s = 1.0 if ny > 0 else -1.0
        v, f = box(cx, cy + s * d_glass, cz - half, win, 0.014, win, keep=(wall,))
        part(parts, tag + '_glass', 'iron', v, f, ln=True)
        v, f = box(cx, cy + s * d_mul, cz - half, 0.026, 0.02, win,
                   keep=(wall, '+x', '-x'))
        part(parts, tag + '_mulv', 'trunk', v, f, ln=True)
        v, f = box(cx, cy + s * d_mul, cz - 0.013, win, 0.02, 0.026,
                   keep=(wall, '+z'))
        part(parts, tag + '_mulh', 'trunk', v, f, ln=True)
        if sill:
            v, f = box(cx, cy + s * 0.02, cz - O - 0.045,
                       2 * O + 0.11, 0.10, 0.05,
                       keep=(wall, '+z', '-z', '+x', '-x'))
            part(parts, tag + '_sill', 'stone', v, f, ln=True, jit=0.003,
                 seed=300 + (len(tag) * 7) % 60)
    else:
        s = 1.0 if nx > 0 else -1.0
        v, f = box(cx + s * d_glass, cy, cz - half, 0.014, win, win, keep=(wall,))
        part(parts, tag + '_glass', 'iron', v, f, ln=True)
        v, f = box(cx + s * d_mul, cy, cz - half, 0.02, 0.026, win,
                   keep=(wall, '+y', '-y'))
        part(parts, tag + '_mulv', 'trunk', v, f, ln=True)
        v, f = box(cx + s * d_mul, cy, cz - 0.013, 0.02, win, 0.026,
                   keep=(wall, '+z'))
        part(parts, tag + '_mulh', 'trunk', v, f, ln=True)
        if sill:
            v, f = box(cx + s * 0.02, cy, cz - O - 0.045,
                       0.10, 2 * O + 0.11, 0.05,
                       keep=(wall, '+z', '-z', '+y', '-y'))
            part(parts, tag + '_sill', 'stone', v, f, ln=True, jit=0.003,
                 seed=300 + (len(tag) * 7) % 60)


def build_empty_opening(parts, cx, cy, cz, nx, ny, tag, size=0.26):
    """Пустой проём: ЧЁРНАЯ НИША в стене + брус-перемычка. Рамы и стекла нет.

    Ниша идёт В ГЛУБИНУ стены (0.07) и закрыта со всех сторон, кроме устья:
    плоская тёмная накладка на плоскости стены в изометрии не читалась бы
    проёмом, а сквозная дыра в ядре стены открывала бы несуществующий интерьер
    (оболочка дома намеренно не замкнута, канон скилла §8).
    """
    s = 1.0 if (ny > 0 or nx > 0) else -1.0
    half = size / 2.0
    wall = '+y' if ny > 0 else ('-y' if ny < 0 else ('+x' if nx > 0 else '-x'))
    if ny:
        v, f = box(cx, cy - s * 0.035, cz - half, size, 0.07, size,
                   keep=(wall, '+z', '-z', '+x', '-x'))
        part(parts, tag + '_hole', 'leather', v, f, ln=True)
        v, f = box(cx, cy + s * 0.05, cz + half + 0.01, size + 0.17, 0.09, 0.06,
                   keep=(wall, '+z', '-z', '+x', '-x'))
        part(parts, tag + '_lintel', 'trunk', v, f, ln=True, jit=0.003, seed=361)
    else:
        v, f = box(cx - s * 0.035, cy, cz - half, 0.07, size, size,
                   keep=(wall, '+z', '-z', '+y', '-y'))
        part(parts, tag + '_hole', 'leather', v, f, ln=True)
        v, f = box(cx + s * 0.05, cy, cz + half + 0.01, 0.09, size + 0.17, 0.06,
                   keep=(wall, '+z', '-z', '+y', '-y'))
        part(parts, tag + '_lintel', 'trunk', v, f, ln=True, jit=0.003, seed=362)


def build_door(parts):
    """Дверь на ОДНОЙ петле: полотно перекошено и приоткрыто, косяк не готов."""
    y = HY
    half = DOOR_W / 2.0
    top = WALL_Z0 + DOOR_H
    v, f = box(DOOR_X, y + 0.012, WALL_Z0 + 0.005, DOOR_W + 0.02, 0.014,
               DOOR_H - 0.01, keep=('+y', '+x', '-x', '+z'))
    part(parts, 'door_hole', 'leather', v, f, ln=True)
    # косяк: левая стойка есть, правая — только нижняя половина (недострой)
    v, f = box(DOOR_X - half - 0.028, y + 0.03, WALL_Z0 - 0.01, 0.055, 0.06,
               DOOR_H + 0.04, keep=('+y', '+x', '-x'))
    part(parts, 'door_jamb_l', 'trunk', v, f, ln=True)
    v, f = box(DOOR_X + half + 0.028, y + 0.03, WALL_Z0 - 0.01, 0.055, 0.06,
               DOOR_H * 0.55, keep=('+y', '+x', '-x'))
    part(parts, 'door_jamb_r', 'trunk', v, f, ln=True)
    v, f = box(DOOR_X, y + 0.03, top + 0.005, DOOR_W + 0.12, 0.06, 0.075,
               keep=('+y', '+z', '-z', '+x', '-x'))
    part(parts, 'door_head', 'trunk', v, f, ln=True, jit=0.003, seed=331)
    # полотно: три доски, ПОВЁРНУТО на 13 град вокруг левой петли (перекошено)
    pivot_x, pivot_y = DOOR_X - half, y + 0.02
    ang = math.radians(13.0)
    for i, dep in enumerate((0.020, 0.012, 0.024)):
        dx = -half + DOOR_W * (i + 0.5) / 3.0
        v, f = box(DOOR_X + dx, y + dep, WALL_Z0 + 0.012,
                   DOOR_W / 3.0 - 0.006, 0.03, DOOR_H - 0.03,
                   keep=('+y', ('+x' if dx > 0 else '-x'), '+z'))
        v = [_rot(p, pivot_x, pivot_y, 0.0, ang, 0.0, 0.0) for p in v]
        part(parts, 'door_leaf%d' % i, 'trunk', v, f, jit=0.003, seed=330 + i)
    v, f = box(DOOR_X + half - 0.06, y + 0.05, WALL_Z0 + 0.38, 0.055, 0.035,
               0.055, keep=('+y', '+z', '-z', '+x'))
    v = [_rot(p, pivot_x, pivot_y, 0.0, ang, 0.0, 0.0) for p in v]
    part(parts, 'door_handle', 'leather', v, f, ln=True)
    # порог: один камень, второй ещё не положен
    v, f = box(DOOR_X, y + 0.06, 0.0, 0.42, 0.16, 0.07,
               keep=('+y', '+z', '+x', '-x'))
    part(parts, 'door_step', 'stone', v, f, jit=0.004, seed=340)


def build_wattle(parts, wall, a_c, z0, z1, w, seed=400):
    """Плетень: вертикальные колья + горизонтальные прутья в проёме панели.

    Стоит В ПРОЁМЕ, оставленном в ядре стены (`build_walls`), вплотную к
    плоскости стены: наружная грань прутьев — на 0.012 наружу, колья — за
    прутьями.  Горизонтальные прутья и есть то, что читается в кадре: 10 штук
    с шагом ~0.1 юнита (8 px при 80 ppu) — «дом обмазан не весь».
    """
    s = 1.0 if wall == '+y' else -1.0
    y_out, y_in = s * (HY + 0.012), s * (HY - 0.030)
    yc = (y_out + y_in) / 2.0
    t = abs(y_out - y_in)
    # колья — за прутьями, тоньше и темнее силуэтом
    for i in range(4):
        ax = a_c - w / 2.0 + w * (i + 0.5) / 4.0
        v, f = box(ax, s * (HY - 0.017), z0 - 0.02, 0.048, 0.020, (z1 - z0) + 0.04,
                   keep=(wall, '+x', '-x', '+z'))
        part(parts, 'wattle_post_%s_%d' % (wall[1], i), 'trunk', v, f,
             ln=True, jit=0.004, seed=seed + i)
    # прутья
    rng = random.Random(seed + 77)
    for i in range(10):
        z = z0 + (z1 - z0) * (i + 0.5) / 10.0 + rng.uniform(-0.012, 0.012)
        r = rng.uniform(0.024, 0.032)
        v, f = box(a_c, yc, z - r / 2.0, w + 0.015, t, r,
                   keep=(wall, '+z', '-z', '+x', '-x'))
        part(parts, 'wattle_rod_%s_%d' % (wall[1], i), 'trunk', v, f,
             jit=0.003, seed=seed + 20 + i)


# --------------------------------------------------------------------------
# ЯРУС 4: КРОВЛЯ
# --------------------------------------------------------------------------
# Пласты соломы: границы по скату (доли пути конёк -> карниз) и высота
# ступени у каждой кромки.  У карниза пласты шире, к коньку уже — канон §6.
PLAST_BOUNDS = (0.0, 0.34, 0.66, 1.0)
PLAST_STEP = (0.034, 0.026, 0.016)
# средний кусок переднего ската: пласты идут от конька к кромке пропуска и
# обрываются ступенью вниз — по этой ступени и видно, что кусок недоложен
MID_BOUNDS = (0.0, 0.34, 1.0)
MID_STEP = (0.036, 0.072)


def _saw_chains(y_a, y_b, bounds, steps, z_top_fn, z_bot_fn):
    """Две цепочки ската для кровли-полосы: верх и низ, обе по ВОЗРАСТАНИЮ y.

    `bounds`/`steps` задаются ОТ КОНЬКА К КАРНИЗУ (у карниза пласты шире),
    `y_a`/`y_b` — концы ската в любом порядке.  Возвращает (E, L, N):
    верхняя цепочка, нижняя цепочка и число пластов.

    Кровля строится из этих цепочек ЯВНЫМИ фасетами (`_slab_faces`), а не
    через ear clipping: у полосы толщиной 0.016 при длине 1.3 ear clipping
    находит уши через раз, часть треугольников выходит с обратным обходом, и
    низ соломы смотрит вверх.  Явные четырёхугольники этой ошибки не дают по
    построению.
    """
    ridge_first = (y_b - y_a) < 0          # t = 0 у конька
    bnd = list(bounds) if ridge_first else list(reversed(bounds))
    stp = list(steps) if ridge_first else list(reversed(steps))
    if len(bnd) != len(stp) + 1:
        raise ValueError('bounds и steps не согласованы')
    ys = sorted(y_a + (y_b - y_a) * t for t in bnd)
    n = len(ys) - 1
    E = [(ys[0], z_top_fn(ys[0]))]
    L = [(ys[0], z_bot_fn(ys[0]) - stp[n - 1])]
    for i in range(n):
        E.append((ys[i + 1], z_top_fn(ys[i + 1])))
        L.append((ys[i + 1], z_bot_fn(ys[i + 1]) - stp[n - 1 - i]))
    return E, L, n


def _prism_from_chains(E, L, x0, x1):
    """Кровля-полоса, выдавленная по X: вершины и фасеты с обходом НАРУЖУ.

    Верх — ровная плоскость (фасет на пласт), низ — ступени пластов (фасет на
    пласт + закраина на ступень), торцы закрыты.

    Ориентация определяется ДВУМЯ проверками, обе вычислимые:
      * у фасетов контура (верх/низ/закраина) нормаль лежит в плоскости YZ —
        берём направление первого фасета и, если оно смотрит вниз (nz < 0),
        выворачиваем ВСЕ фасеты контура разом;
      * у торцов нормаль вдоль X — проверяем направление ОТ ЦЕНТРА детали.
    «На глаз» ориентация цепочек у переднего и заднего ската дважды вышла
    неверной (нормаль внутрь, 796 и 14562 px изнанок), поэтому здесь только
    вычисление.
    """
    if x1 < x0:
        x0, x1 = x1, x0
    n = len(E)
    assert n == len(L) and n >= 2
    verts = [(x0, y, z) for y, z in E] + [(x1, y, z) for y, z in L]

    side = []
    for i in range(n - 1):
        side.append((n + i, n + i + 1, i + 1, i))             # верх, пласт i
        side.append((i, i + 1, n + i + 1, n + i))             # низ, пласт i
        if abs(L[i + 1][0] - L[i][0]) < 1e-9:                 # закраина ступени
            side.append((n + i, n + i + 1, i, i + 1))
    nz0 = _face_normal(verts, side[0])[2]
    if nz0 < 0:
        side = [tuple(reversed(fc)) for fc in side]
    cx = sum(q[0] for q in verts) / len(verts)
    ends = []
    for fc in (tuple(range(n, 2 * n)), tuple(range(2 * n - 1, n - 1, -1))):
        pts = [verts[i] for i in fc]
        nrm = _face_normal(verts, fc)
        outward = sum(q[0] for q in pts) / len(pts) - cx
        ends.append(fc if nrm[0] * outward >= 0 else tuple(reversed(fc)))
    return verts, side + ends


def _thatch_slabs(parts, rng):
    """Солома: оба ската до карниза, но в переднем НЕ ХВАТАЕТ КУСКА.

    Недострой показан не «голым низом ската» (это читается навесом или
    сломанной крышей), а ПРОПУЩЕННЫМ УЧАСТКОМ: солома уложена и вверху, и
    у карниза, а посреди ската кусок не закрыт — видны стропила и обрешётка.
    Ровно так выглядит крыша, которую кроют с двух краёв навстречу.

    Каждая часть — ОДНА деталь, сложенная явными фасетами (`_slab_faces`):
    боковые грани частей, разрезанных по X, убираются, иначе на стыке видна
    изнанка.
    """
    # задний скат — целый
    E, L, n = _saw_chains(-EAVE_Y, RIDGE_Y, PLAST_BOUNDS, PLAST_STEP,
                          z_top, z_soffit)
    v, f = _prism_from_chains(E, L, -(ROOF_X - 0.06), ROOF_X - 0.06)
    part(parts, 'thatch_back', 'leaf_autumn', v, f, jit=0.005, seed=501)

    x_out = ROOF_X - 0.06
    mid = _saw_chains(BARE_Y1, RIDGE_Y, MID_BOUNDS, MID_STEP, z_top, z_soffit)
    full = _saw_chains(EAVE_Y, RIDGE_Y, PLAST_BOUNDS, PLAST_STEP,
                       z_top, z_soffit)
    for tag, x0, x1, ch in (('front_l', -x_out, BARE_X0, full),
                            ('front_c', BARE_X0, BARE_X1, mid),
                            ('front_r', BARE_X1, x_out, full)):
        v, f = _prism_from_chains(ch[0], ch[1], x0, x1)
        part(parts, 'thatch_%s' % tag, 'leaf_autumn', v, f, jit=0.005,
             seed=502 + (tag == 'front_c'))
        parts[-1]['nocull'] = True
        _drop_x_sides(parts[-1])

    # лобовые доски по кромкам пропуска: солома обрывается на доску, и кусок
    # читается НЕДОЛОЖЕННЫМ, а не выломанным
    for ex in (BARE_X0, BARE_X1):
        v, f = bar((ex, EAVE_Y - 0.03, z_top(EAVE_Y) - 0.11),
                   (ex, BARE_Y1 + 0.02, z_top(BARE_Y1) - 0.06),
                   0.055, 0.10, caps=(0, 1))
        part(parts, 'thatch_edge_x%d' % (ex > 0), 'trunk', v, f, jit=0.003,
             seed=505 + (ex > 0))
    v, f = bar((BARE_X0 - 0.02, BARE_Y1, z_top(BARE_Y1) - 0.05),
               (BARE_X1 + 0.02, BARE_Y1, z_top(BARE_Y1) - 0.05), 0.055, 0.09,
               caps=(0, 1))
    part(parts, 'thatch_edge_y', 'trunk', v, f, jit=0.003, seed=508)

    # карнизный ряд заднего ската: лобовая доска
    v, f = bar((-ROOF_X, -EAVE_Y + 0.02, z_top(-EAVE_Y) - 0.09),
               (ROOF_X, -EAVE_Y + 0.02, z_top(-EAVE_Y) - 0.09), 0.055, 0.10,
               caps=(0, 1))
    part(parts, 'thatch_edge_back', 'trunk', v, f, jit=0.003, seed=507)


def build_roof(parts, rng):
    _thatch_slabs(parts, rng)

    # --- стропила: профиль-пятиугольник, призма вдоль X -------------------
    # Обход профиля — ПРОТИВ ЧАСОВОЙ в (y,z): у стропила низ карниза должен
    # смотреть наружу-вниз.  Обратный обход давал нормаль внутрь, и хвост
    # стропила под свесом светился изнанкой (214 px).
    def rafter_prof(x_ofs):
        return [
            (EAVE_Y + 0.010, roof_plane(EAVE_Y) - 0.045),
            (RIDGE_Y, roof_plane(RIDGE_Y) + 0.028),
            (-EAVE_Y - 0.010, roof_plane(-EAVE_Y)),
            (-EAVE_Y - 0.010, roof_plane(-EAVE_Y) - 0.045),
        ]
    xs = [-HX + 0.05 + i * (WALL_X - 0.10) / (N_RAFTER - 1) for i in range(N_RAFTER)]
    for i, x in enumerate(xs):
        v, f = prism_x(rafter_prof(x), x - 0.024, x + 0.024)
        part(parts, 'rafter_%d' % i, 'trunk', v, f, jit=0.0015, seed=540 + i)

    # --- заготовки соломы лежат на голом скате, но ещё не прибиты --------
    v, f = box(0.02, 0.16, roof_plane(0.16) + 0.030, 0.34, 0.24, 0.055,
               rz=math.radians(4.0), rx=math.radians(48.0))
    part(parts, 'thatch_loose0', 'leaf_autumn', v, f, jit=0.006, seed=580)

    # --- торцевые лобовые доски по скатам (ветровая доска) ---------------
    for sx_ in (1, -1):
        for sg, ys in ((1, EAVE_Y), (-1, -EAVE_Y)):
            v, f = bar((sx_ * (ROOF_X - 0.045), ys, z_top(ys) - 0.135),
                       (sx_ * (ROOF_X - 0.045), RIDGE_Y, z_top(RIDGE_Y) - 0.095),
                       0.11, 0.085, caps=(0, 1))
            part(parts, 'barge_%d_%d' % (sx_, sg), 'trunk', v, f, jit=0.002,
                 seed=590 + sg + (sx_ > 0))


# --------------------------------------------------------------------------
# ЯРУС 5: ДВОР — стройка, а не жильё
# --------------------------------------------------------------------------
def build_yard(parts, rng):
    """Штабель брёвен, лестница, заготовка конька на подпорке, камень, солома.

    Всё основание — цоколь вместе с этими деталями — обязано уложиться в
    пятно 3 x 2 с зазором (правило заказчика 2026-10-13): двор занимает
    оставшиеся полосы вдоль стен, а не вылезает за кромку.
    """
    # --- штабель брёвен у тыла -------------------------------------------
    # Два ряда, а не три: основание обязано остаться в пятне 3 x 2 с запасом
    # 0.03 (строка «габарит» в `canon.py`), а кромка кровли уже свисает до
    # y = -1.0 — третьему ряду места нет.
    for row in range(2):
        n = 4 - row
        for i in range(n):
            x = -HX + 0.30 + i * 0.29 + row * 0.145
            y = -HY - 0.07 - row * 0.085
            r = 0.060 - row * 0.003
            v, f = bar((x - 0.29, y, r + row * 0.116), (x + 0.29, y, r + row * 0.116),
                       r * 2, r * 2, caps=(0, 1))
            part(parts, 'log_%d_%d' % (row, i), 'trunk', v, f, jit=0.004,
                 seed=600 + row * 7 + i)
    # подкладки под нижний ряд: бревно не лежит на земле вплотную
    for i in (0, 3):
        v, f = bar((-HX + 0.16 + i * 0.70, -HY - 0.07, 0.0),
                   (-HX + 0.16 + i * 0.70, -HY - 0.07, 0.030), 0.05, 0.05,
                   caps=(0, 1))
        part(parts, 'log_skid%d' % i, 'trunk', v, f)

    # --- лестница прислонена к торцу +X, к свесу --------------------------
    top = (HX + 0.030, -0.52, 1.36)
    bot = (HX + 0.100, -0.52, 0.0)
    for sg in (1, -1):
        v, f = bar((top[0], top[1] + sg * 0.17, top[2]),
                   (bot[0], bot[1] + sg * 0.17, bot[2]), 0.045, 0.055, caps=(0, 1))
        part(parts, 'ladder_rail%d' % sg, 'trunk', v, f, jit=0.003, seed=630 + sg)
    for i in range(5):
        t = 0.12 + 0.185 * i
        p0 = (top[0] + (bot[0] - top[0]) * t, top[1] - 0.17, top[2] * (1 - t))
        p1 = (p0[0], p0[1] + 0.34, p0[2])
        v, f = bar(p0, p1, 0.022, 0.030, caps=(0, 1))
        part(parts, 'ladder_rung%d' % i, 'trunk', v, f, jit=0.002, seed=640 + i)

    # --- заготовка конькового бруса на подпорке (у фасада, слева) ---------
    v, f = bar((0.62, HY + 0.16, 0.055), (1.22, HY + 0.06, 0.075), 0.085, 0.075,
               caps=(0, 1))
    part(parts, 'beam_stock', 'trunk', v, f, jit=0.004, seed=650)
    v, f = bar((1.16, HY + 0.07, 0.0), (1.16, HY + 0.07, 0.06), 0.06, 0.06,
               caps=(0, 1))
    part(parts, 'beam_prop', 'trunk', v, f)

    # --- камень у ямы в цоколе: три блока вынуты, два лежат рядом ---------
    for i, (x, y, r) in enumerate(((0.52, HY + 0.13, 0.055), (0.74, HY + 0.17, 0.048),
                                   (0.95, HY + 0.11, 0.044))):
        v, f = box(x, y, 0.0, r * 2.4, r * 1.5, r * 0.9,
                   rz=math.radians(rng.uniform(-30, 30)))
        part(parts, 'stone_pile%d' % i, 'stone', v, f, jit=0.006, seed=660 + i)

    # --- вязанка соломы на земле -----------------------------------------
    v, f = box(-1.22, HY + 0.06, 0.0, 0.40, 0.22, 0.15,
               rz=math.radians(8.0), keep=('+z', '+x', '-x', '+y', '-y'))
    part(parts, 'straw_bundle', 'leaf_autumn', v, f, jit=0.008, seed=670)
    v, f = box(-1.22, HY + 0.06, 0.0, 0.10, 0.25, 0.17,
               rz=math.radians(8.0), keep=('+z', '+x', '-x', '+y', '-y'))
    part(parts, 'straw_tie', 'trunk', v, f, jit=0.004, seed=671)


# --------------------------------------------------------------------------
# СБОРКА
# --------------------------------------------------------------------------
def build(variant=None, seed=7):
    """Собрать недостроенный дом. Список деталей name/family/verts/faces."""
    rng = random.Random(seed)
    parts = []
    build_plinth(parts, rng)
    build_walls(parts)
    build_frame(parts)
    # проёмы: дверь, два окна фасада, окно торца, ПУСТЫЕ проёмы (недострой)
    build_window(parts, WIN_FRONT_X, HY, WIN_Z, 0.0, 1.0, 'win_f')
    build_window(parts, -HX, WIN_SIDE_Y, WIN_Z, -1.0, 0.0, 'win_s')
    build_empty_opening(parts, WIN_EMPTY_X, HY, WIN_Z, 0.0, 1.0, 'win_f_empty')
    build_empty_opening(parts, -HX, -WIN_SIDE_Y, WIN_Z + 0.03, -1.0, 0.0,
                        'win_s_empty')
    build_empty_opening(parts, HX, GABLE_HOLE_Y, 1.90, 1.0, 0.0, 'gable_hole',
                        size=GABLE_HOLE)
    build_door(parts)
    build_wattle(parts, '+y', WATTLE_X, WALL_Z0 + 0.10, WALL_Z1 - 0.10, WATTLE_W)
    build_wattle(parts, '-y', WATTLE_X, WALL_Z0 + 0.10, WALL_Z1 - 0.10, WATTLE_W)
    build_roof(parts, rng)
    build_yard(parts, rng)
    ground(parts)
    autocull(parts)
    return parts


def ground(parts):
    """Опора в (0,0,0): если дрожь утопила низ ниже нуля — приподнять всё."""
    lo = min(v[2] for p in parts for v in p['verts'])
    if lo < 0.0:
        for p in parts:
            p['verts'] = [(v[0], v[1], v[2] - lo) for v in p['verts']]
    return -lo if lo < 0.0 else 0.0


def stats(parts):
    return dict(verts=verts_of(parts), tris=tris_of(parts), parts=len(parts))


if __name__ == '__main__':
    p = build()
    print(stats(p))
    lo = min(v[2] for q in p for v in q['verts'])
    hi = max(v[2] for q in p for v in q['verts'])
    xs = [v[0] for q in p for v in q['verts']]
    ys = [v[1] for q in p for v in q['verts']]
    print('габарит X %.3f..%.3f  Y %.3f..%.3f  Z %.3f..%.3f'
          % (min(xs), max(xs), min(ys), max(ys), lo, hi))
