"""blender_live.py — сборка и съёмка модели ВНУТРИ живого Blender. Импортируется.

Этот модуль исполняется только внутри Blender (у него на входе `bpy`), поэтому
его нельзя запускать «просто питоном».  Точка входа — `templates/build_live.py`,
который гоняет клиент `scripts/mcp.py` через сокет аддона blender-mcp.

Зачем отдельный модуль, если есть Blender: чистая геометрия строится в
`forge`-генераторе (её можно мерить и повторять без Blender), а здесь только
то, что без Blender не живёт — материалы, свет, камера, рендер, экспорт.

ЖЕЛЕЗНЫЕ ПРАВИЛА ЖИВОЙ СЕССИИ (каждое — вылеченные грабли):
    1) заказчик открыт в этом же Blender, поэтому НИКОГДА не звать
       `bpy.ops.wm.read_factory_settings` — это сносит его файл со всеми
       сценами.  Признак фонового режима — ТОЛЬКО `bpy.app.background`
       (`bpy.context.window is None` бывает и в контексте таймера аддона);
    2) чужой файл не сохранять: `.blend` отдаётся КОПИЕЙ
       (`save_as_mainfile(copy=True)`);
    3) работать в своей сцене и со своим префиксом имён, чистить только свои
       объекты;
    4) выделение перед экспортом — через `select_set`, а не `bpy.ops`
       (в контексте таймера аддона оператор молча не срабатывает, и в GLB
       уезжает чужой объект из сцены заказчика);
    5) glTF-экспортёр без `use_active_scene` тащит в файл ВСЕ сцены файла.

КАМЕРА И СВЕТ — КАНОННЫЕ (их нельзя «улучшать» по дороге): изометрия 2:1,
азимут 45, подъём 35.2644, солнце (-0.36, 0.30, 0.88) с энергией 2.05, небо
(0.62, 0.66, 0.72) с силой 0.42, плоское небо и НИКАКОГО экранного GI.
"""
import json
import math
import os

import bpy
from mathutils import Matrix, Vector

import forge as F
import ruin_palette as V

AZ = math.radians(45.0)
EL = math.atan(1.0 / math.sqrt(2.0))            # 35.2644 — ромб 2:1
SUN_DIR = Vector((-0.36, 0.30, 0.88)).normalized()
SUN_ENERGY = 2.05
AMBIENT_COLOR = (0.62, 0.66, 0.72)
AMBIENT_STRENGTH = 0.42
RES_X, RES_Y = 512, 640
PPU = 80.0
ROTATIONS = (0, 90, 180, 270)

# Базовые цвета материалов ЛИНЕЙНО (линейный hex), подобранные калибровкой:
# они ТЕМНЕЕ целевых тонов спрайта, потому что тон поднимает сцена (солнце +
# небо), а не материал.  Значения сняты калибровкой на доме жителя и дают
# 99.2..99.7% пикселей спрайта в палитре канона (гейт требует >=93%).
# Если менять сцену (солнце, небо, экспозицию) — калибровку надо прогнать
# заново, иначе палитра уедет молча.
# Формат — как у файла калибровки: семейство -> {'0': светлый, '1': средний,
# '2': тёмный}.  Ключи именно строки: так же устроен pal_cal.json, и на этом
# различии уже спотыкались (кортеж вместо словаря молча уводил материалы в
# тёмный fallback, и постройка выходила почти чёрной).
DEFAULT_CAL = {
    'trunk':       {'0': '#2B1207', '1': '#2A1107', '2': '#100602'},
    'stone':       {'0': '#40545B', '1': '#454F53', '2': '#1D2221'},
    'skin':        {'0': '#FF953D', '1': '#E46F2D', '2': '#572D13'},
    'leaf_autumn': {'0': '#7D3204', '1': '#833504', '2': '#2E1102'},
    'grass':       {'0': '#12420C', '1': '#00B90B', '2': '#0E2D08'},
    'iron':        {'0': '#4D5B62', '1': '#46515D', '2': '#1D2426'},
    'leather':     {'0': '#150A04', '1': '#0C0602', '2': '#060202'},
}
# Подъём тона, если калибровки нет: фасет, повёрнутый к камере, отдаёт около
# половины линейного альбедо (замер по эталонам).
LIFT = 2.0
AMBIENT_W = 0.15                 # доля неба в ожидаемой яркости фасета


# --------------------------------------------------------------------------
# ЦВЕТ
# --------------------------------------------------------------------------
def _lin(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def _to_lin(hex_rgb):
    return [_lin(((hex_rgb >> s) & 255) / 255.0) for s in (16, 8, 0)]


def _lin_hex(rgb):
    out = 0
    for c in rgb:
        out = (out << 8) | int(round(max(0.0, min(1.0, c)) * 255))
    return out


def _hex_to_int(s):
    return int(str(s).lstrip('#'), 16)


class Calibration(object):
    """Базовые цвета материалов: файл калибровки, иначе встроенная таблица."""

    def __init__(self, path=None, palette=None):
        self.pal = palette or F.Palette()
        self.data = None
        if path and os.path.exists(path):
            try:
                with open(path, encoding='utf-8') as f:
                    self.data = json.load(f)
            except Exception:
                self.data = None
        if self.data is None:
            self.data = DEFAULT_CAL

    def base_hex(self, family, tone):
        """Линейный hex базового цвета материала (тон 0/1/2)."""
        try:
            val = self.data[family]
            if isinstance(val, dict):
                return _hex_to_int(val[str(tone)])
            return _hex_to_int(val[tone])          # кортеж тоже принимаем
        except Exception:
            target = self.pal.hex_rgb(self.pal.tones(family)[tone])
            lin = _to_lin((target[0] << 16) | (target[1] << 8) | target[2])
            return _lin_hex([c / LIFT for c in lin])

    def save(self, path):
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(self.data, f, ensure_ascii=False, indent=1)
        return path


# --------------------------------------------------------------------------
# СЦЕНА
# --------------------------------------------------------------------------
def _find(scene, name):
    """Свой объект по имени, включая варианты вида `name.001`."""
    for ob in scene.objects:
        if ob.name == name or ob.name.startswith(name + '.'):
            return ob
    return None


def use_scene(name, fresh=False):
    """Своя сцена. В живой сессии чужой файл не сбрасываем НИКОГДА."""
    if fresh and bpy.app.background:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        sc = bpy.context.scene
        sc.name = name
        return sc
    if not bpy.app.background and bpy.context.window is None:
        raise RuntimeError(
            'у Blender нет активного окна: сборку в живой сессии вести нельзя, '
            'а файл заказчика мы не сбрасываем. Переключитесь в окно Blender.')
    sc = bpy.data.scenes.get(name)
    if sc is None:
        sc = bpy.data.scenes.new(name)
    if bpy.context.window is not None:
        bpy.context.window.scene = sc
    return sc


def clear_own(scene, prefix, keep=()):
    """Убрать из сцены ТОЛЬКО свои объекты (по префиксу имён).

    `keep` — короткие имена, которые трогать нельзя (`cam`, `sun`): в цикле по
    поворотам модель пересобирается, а камера и солнце живут весь прогон.
    Без этого `clear_own` сносит камеру, и рендер падает с «no camera».
    """
    protect = tuple(prefix + k for k in keep)

    def guarded(name):
        # Blender дописывает .001 при коллизии имён: если защищать только точное
        # имя, «fb_cam.001», созданная в этом же прогоне, будет снесена — и
        # рендер упадёт с «no camera».  Поэтому защита по ПРЕФИКСУ.
        return any(name == p or name.startswith(p + '.') for p in protect)

    for ob in list(scene.objects):
        if ob.name.startswith(prefix) and not guarded(ob.name):
            bpy.data.objects.remove(ob, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.cameras, bpy.data.lights,
                 bpy.data.worlds):
        for item in list(coll):
            if item.users == 0 and item.name.startswith(prefix):
                coll.remove(item)


def drop_materials(prefix):
    for mat in list(bpy.data.materials):
        if mat.name.startswith(prefix):
            bpy.data.materials.remove(mat)


def make_material(name, hex_lin, rough=0.86, spec=0.02):
    r, g, b = [((hex_lin >> s) & 255) / 255.0 for s in (16, 8, 0)]
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = (r, g, b, 1.0)
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Metallic'].default_value = 0.0
    for key in ('Specular IOR Level', 'Specular'):
        if key in bsdf.inputs:
            bsdf.inputs[key].default_value = spec
            break
    mat.diffuse_color = (r, g, b, 1.0)
    return mat


def setup(scene, prefix, ppu=None, res=None, samples=64, cal=None):
    """Камера, свет, небо и настройки рендера пайплайна. Возвращает (cam, sun)."""
    global PPU, RES_X, RES_Y
    if ppu:
        PPU = float(ppu)
    if res:
        RES_X, RES_Y = int(res[0]), int(res[1])
    scene.render.resolution_x, scene.render.resolution_y = RES_X, RES_Y
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    scene.render.image_settings.color_depth = '8'
    scene.view_settings.view_transform = 'Standard'
    scene.view_settings.look = 'None'
    scene.view_settings.exposure = 0.0
    scene.view_settings.gamma = 1.0
    for eng in ('BLENDER_EEVEE', 'BLENDER_EEVEE_NEXT', 'CYCLES'):
        try:
            scene.render.engine = eng
            break
        except TypeError:
            continue
    # ДИЗЕРИНГ ГАСИМ: он добавляет к кадру шум +-1 LSB, и метрика детализации
    # гейта (10 частых цветов) рассыпает спрайт на сотни «фасетов».
    scene.render.dither_intensity = 0.0
    # ЭКРАННЫЙ GI/AO ГАСИМ: канон требует плоских крупных фасетов, а трассировка
    # размазывает цвет по большой плоскости на 2..3 тона.
    try:
        scene.eevee.use_raytracing = False
    except Exception:
        pass
    try:
        scene.eevee.taa_render_samples = samples
    except Exception:
        pass

    # камера: ортоканон, матрицу строим сами (track_quat даёт лишний поворот).
    # Объект переиспользуем, если он уже есть: иначе повторный прогон плодит
    # fb_cam.001, и `scene.camera` начинает указывать на свежий, который потом
    # может быть снесён как «свой».
    cam = _find(scene, prefix + 'cam')
    if cam is None:
        cam_data = bpy.data.cameras.new(prefix + 'cam')
        cam = bpy.data.objects.new(prefix + 'cam', cam_data)
        bpy.context.collection.objects.link(cam)
    cam.data.type = 'ORTHO'
    cam.data.ortho_scale = RES_Y / float(PPU)
    fwd = Vector((math.cos(EL) * math.cos(AZ), -math.cos(EL) * math.sin(AZ),
                  -math.sin(EL)))
    right = fwd.cross(Vector((0, 0, 1))).normalized()
    up = right.cross(fwd).normalized()
    cam.location = Vector((0.0, 0.0, 0.0)) - fwd * 40.0
    cam.rotation_euler = Matrix(((right.x, up.x, -fwd.x),
                                 (right.y, up.y, -fwd.y),
                                 (right.z, up.z, -fwd.z))).to_euler('XYZ')
    scene.camera = cam

    # солнце
    prop = -SUN_DIR
    r2 = prop.cross(Vector((0, 0, 1)))
    if r2.length < 1e-6:
        r2 = Vector((1, 0, 0))
    r2.normalize()
    up2 = r2.cross(prop).normalized()
    sun = _find(scene, prefix + 'sun')
    if sun is None:
        ld = bpy.data.lights.new(prefix + 'sun', 'SUN')
        sun = bpy.data.objects.new(prefix + 'sun', ld)
        bpy.context.collection.objects.link(sun)
    sun.data.energy = SUN_ENERGY
    sun.data.angle = math.radians(4.0)
    sun.rotation_euler = Matrix(((r2.x, up2.x, -prop.x),
                                 (r2.y, up2.y, -prop.y),
                                 (r2.z, up2.z, -prop.z))).to_euler('XYZ')

    world = bpy.data.worlds.new(prefix + 'world')
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes['Background']
    bg.inputs['Color'].default_value = (*AMBIENT_COLOR, 1.0)
    bg.inputs['Strength'].default_value = AMBIENT_STRENGTH
    return cam, sun


# --------------------------------------------------------------------------
# МЕШ, МАТЕРИАЛЫ, ТОНА
# --------------------------------------------------------------------------
def build_object(parts, name, prefix, palette=None, cal=None, scene=None):
    """Собрать один меш из деталей и разложить фасеты по тонам ПО НОРМАЛИ.

    Тона считаются ПОСЛЕ поворота модели — иначе после поворота на 90 солнце
    остаётся прежним, а фасеты уже другие, и канон тонов едет.
    """
    scene = scene or bpy.context.scene
    pal = palette or F.Palette()
    calibration = cal or Calibration(palette=pal)
    verts, faces, fam_of_face = [], [], []
    for p in parts:
        off = len(verts)
        verts.extend([tuple(v) for v in p['verts']])
        for f in p['faces']:
            faces.append(tuple(off + i for i in f))
            fam_of_face.append(p['family'])
    # СЕМЕЙСТВО ПОЛИГОНА НАДО ПОМНИТЬ.  У свежего меша material_index у всех
    # полигонов = 0, и если брать семейство из слота, ВСЯ постройка красится
    # первым семейством (у нас это тёмное дерево) — грабли, которые видно
    # только на рендере.
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.validate(verbose=False)
    me.update()
    ob = bpy.data.objects.new(name, me)
    (scene.collection if scene else bpy.context.collection).objects.link(ob)
    slots = []
    for fam in pal.FAMILIES:
        rough = 0.92 if fam in ('stone', 'iron') else 0.86
        for tone in range(3):
            mat = make_material('%s%s_%d' % (prefix, fam, tone),
                                calibration.base_hex(fam, tone), rough=rough)
            ob.data.materials.append(mat)
            slots.append((fam, tone))
    for poly in me.polygons:
        poly.use_smooth = False
    assign_tones(ob, slots, fam_of_face, pal)
    return ob, slots, fam_of_face


def build_object_zones(parts, name, prefix, scene=None):
    """Собрать меш и покрасить его ЗОНАМИ ПАЛИТРЫ РАТУШИ — ОДИН материал на зону.

    Ратуша (`townhall/tools/townhall.py`) красится именно так: у каждой детали
    свой материал, а фасеты различаются ЕСТЕСТВЕННЫМ затенением — верх светлее,
    отвёрнутая от солнца грань темнее.  Лагерь переведён на ту же краску
    (`village.py`, задача заказчика «в цветовой гамме ратуши»), и чтобы цвета
    сошлись не «примерно», а тождественно, мало взять те же hex: нужна та же
    СХЕМА раскладки по материалам.  Тоновый автомат (`build_object` +
    `assign_tones`) квантует затенение в три тона и снова развёл бы лагерь с
    ратушей — у той затенение непрерывное; для других проектов он оставлен.

    Слоты создаются только под те зоны, которые в модели есть, в
    алфавитном порядке — порядок слотов детерминирован между прогонами.
    """
    scene = scene or bpy.context.scene
    verts, faces, zone_of_face = [], [], []
    for p in parts:
        off = len(verts)
        verts.extend([tuple(v) for v in p['verts']])
        for f in p['faces']:
            faces.append(tuple(off + i for i in f))
            zone_of_face.append(p['family'])
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.validate(verbose=False)
    me.update()
    ob = bpy.data.objects.new(name, me)
    (scene.collection if scene else bpy.context.collection).objects.link(ob)
    slots = sorted(set(zone_of_face))
    idx = {}
    for i, zone in enumerate(slots):
        hex_lin, rough, spec = V.paint(zone)
        ob.data.materials.append(make_material(prefix + zone, hex_lin,
                                               rough=rough, spec=spec))
        idx[zone] = i
    for i, poly in enumerate(me.polygons):
        poly.use_smooth = False
        poly.material_index = idx[zone_of_face[i]]
    return ob, slots, zone_of_face


def assign_tones(ob, slots, fam_of_face=None, palette=None):
    """Тон фасета по нормали: смотрит в небо — светлый, отвернулся — тёмный.

    `fam_of_face` — семейство каждого полигона в порядке заливки (его вернул
    `build_object`).  Без него семейство бралось бы из слота, а он у всех
    полигонов нулевой.
    """
    pal = palette or F.Palette()
    idx = {}
    for i, (fam, tone) in enumerate(slots):
        idx.setdefault(fam, {})[tone] = i
    for i, poly in enumerate(ob.data.polygons):
        if fam_of_face and i < len(fam_of_face):
            fam = fam_of_face[i]
        else:
            fam = slots[poly.material_index][0]
        if fam not in idx:
            fam = slots[0][0]
        light, mid = pal.thresholds(fam)
        b = max(0.0, poly.normal.dot(SUN_DIR)) + AMBIENT_W
        tone = 0 if b >= light else (1 if b >= mid else 2)
        poly.material_index = idx[fam][tone]


def rotate_meshes(deg, prefix, scene=None):
    """Поворот модели вокруг Z прямо в данных меша (без bpy.ops)."""
    R = Matrix.Rotation(math.radians(deg), 4, 'Z')
    for o in (scene or bpy.context.scene).objects:
        if o.type == 'MESH' and o.name.startswith(prefix):
            o.data.transform(R)
            o.data.update()


def activate(scene):
    """Сделать сцену активной в окне.

    Нужно перед КАЖДЫМ рендером: `bpy.ops.render.render` рендерит АКТИВНУЮ
    сцену контекста, а не ту, у которой выставлен filepath.  В живом Blender
    сцена может переключиться между кадрами (заказчик, другой агент) — и тогда
    кадр молча уходит в чужую сцену, а файл получает чужую постройку.
    """
    win = getattr(bpy.context, 'window', None)
    if win is not None and win.scene is not scene:
        win.scene = scene
    return sc_matches(scene)


def sc_matches(scene):
    win = getattr(bpy.context, 'window', None)
    return win is None or win.scene is scene


def render_to(path, scene=None):
    sc = scene or bpy.context.scene
    activate(sc)
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    return path


def world_size(objs):
    xs, ys, zs = [], [], []
    for o in objs:
        for v in o.data.vertices:
            p = o.matrix_world @ v.co
            xs.append(p.x); ys.append(p.y); zs.append(p.z)
    return (round(max(xs) - min(xs), 3), round(max(ys) - min(ys), 3),
            round(max(zs) - min(zs), 3))


def footprint(objs):
    xs, ys = [], []
    for o in objs:
        for v in o.data.vertices:
            p = o.matrix_world @ v.co
            xs.append(p.x); ys.append(p.y)
    return (round(max(xs) - min(xs), 3), round(max(ys) - min(ys), 3))


# --------------------------------------------------------------------------
# ОТДАЧА
# --------------------------------------------------------------------------
def save_blend_copy(path):
    """Сохранить .blend КОПИЕЙ: файл заказчика остаётся нетронутым."""
    bpy.ops.wm.save_as_mainfile(filepath=path, copy=True, compress=False,
                                check_existing=False)
    return path


def export_model(path_noext, prefix, scene=None):
    """Выгрузить .glb (Y вверх) и .obj (Z вверх) для движка."""
    scene = scene or bpy.context.scene
    meshes = [o for o in scene.objects
              if o.type == 'MESH' and o.name.startswith(prefix)]
    if not meshes:
        raise RuntimeError('нечего выгружать: в сцене нет мешей %s*' % prefix)
    for o in bpy.data.objects:
        try:
            o.select_set(False)
        except Exception:
            pass
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    glb = path_noext + '.glb'
    bpy.ops.export_scene.gltf(filepath=glb, export_format='GLB',
                              use_selection=True, use_active_scene=True,
                              export_yup=True, export_apply=True,
                              export_materials='EXPORT')
    obj = path_noext + '.obj'
    bpy.ops.wm.obj_export(filepath=obj, export_selected_objects=True,
                          export_materials=True, export_uv=False,
                          export_normals=True, export_triangulated_mesh=True,
                          forward_axis='Y', up_axis='Z', apply_modifiers=True)
    return glb, obj


def viewport_camera(shading='MATERIAL'):
    """Поставить вьюпорт в вид камеры: модель видно глазами сразу."""
    win = getattr(bpy.context, 'window', None)
    if win is None:
        return False
    found = False
    for area in win.screen.areas:
        if area.type != 'VIEW_3D':
            continue
        for space in area.spaces:
            if space.type != 'VIEW_3D':
                continue
            space.region_3d.view_perspective = 'CAMERA'
            space.shading.type = shading
            found = True
        area.tag_redraw()
    return found


def closeups(shots, out_dir, prefix='cu', res=(720, 720), scene=None):
    """Крупные планы ВНУТРИ живого Blender с возвратом камеры на место.

    `shots` — список (имя, точка взгляда, цель, фокус).  Камера пайплайна
    ОРТОГРАФИЧЕСКАЯ (кадр спрайта), поэтому на время съёмки она переводится в
    перспективу: у ортокамеры масштаб кадра не зависит от расстояния, и
    «крупный план» ортокамерой не снять.
    """
    sc = scene or bpy.context.scene
    cam = sc.camera
    if cam is None:
        raise RuntimeError('в сцене нет камеры — сначала сборка')
    keep = (tuple(cam.location), tuple(cam.rotation_euler), cam.data.lens,
            cam.data.type, cam.data.ortho_scale, sc.camera,
            sc.render.resolution_x, sc.render.resolution_y, sc.render.filepath)
    activate(sc)
    cam.data.type = 'PERSP'
    sc.render.resolution_x, sc.render.resolution_y = res
    os.makedirs(out_dir, exist_ok=True)
    out = []
    for name, eye, target, lens in shots:
        cam.data.lens = lens
        e = Vector(eye)
        d = Vector(target) - e
        cam.location = e
        cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
        activate(sc)
        sc.render.filepath = os.path.join(out_dir, name + '.png')
        bpy.ops.render.render(write_still=True)
        out.append(sc.render.filepath)
    cam.location, cam.rotation_euler = keep[0], keep[1]
    cam.data.type, cam.data.ortho_scale, cam.data.lens = keep[3], keep[4], keep[2]
    sc.camera = keep[5]
    sc.render.resolution_x, sc.render.resolution_y = keep[6], keep[7]
    sc.render.filepath = keep[8]
    return out
