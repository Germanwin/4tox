"""thpipe — общий пайплайн спрайтов ратуши в стиле атласа mapgen2.

Конвенции (замерены по assets/sprites/atlas.png):
  1 юнит модели = 1 клетка карты. Ратуша занимает 4 x 3 клетки (X — длинная сторона).
  Камера   — ортографическая истинная изометрия: азимут 45°, подъём 35.264°.
  Свет     — сверху-слева-спереди в экранных координатах, фасеты плоские.
  Пунктир  — рамка кадра: орто-масштаб по высоте `ortho`, ppu = res_y / ortho.
"""
import bpy
import bmesh
import math
import os
from mathutils import Matrix, Vector

# --------------------------------------------------------------------------
# КОНВЕНЦИИ
# --------------------------------------------------------------------------
AZ = math.radians(45.0)
EL = math.atan(1.0 / math.sqrt(2.0))            # 35.2644° — ромб 2:1
ORTHO = 8.00
RES_X, RES_Y = 512, 640
PPU = RES_Y / ORTHO                              # ~104.9 px на юнит
ROTATIONS = (0, 90, 180, 270)

# Свет: направление, КУДА летит свет (экранный верх-лево-перед).
SUN_DIR = Vector((-0.36, 0.30, 0.88)).normalized()
SUN_ENERGY = 2.05
AMBIENT_COLOR = (0.62, 0.66, 0.72)
AMBIENT_STRENGTH = 0.42

RED = '\033[31m'
DIM = '\033[2m'
OFF = '\033[0m'


# --------------------------------------------------------------------------
# СЦЕНА
# --------------------------------------------------------------------------
def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.objects,
                 bpy.data.cameras, bpy.data.lights, bpy.data.worlds):
        for item in list(coll):
            coll.remove(item)


def make_material(name, hex_rgb, rough=0.75, spec=0.12):
    r = ((hex_rgb >> 16) & 255) / 255.0
    g = ((hex_rgb >> 8) & 255) / 255.0
    b = (hex_rgb & 255) / 255.0
    mat = bpy.data.materials.new(name)
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


def setup_camera():
    cam_data = bpy.data.cameras.new('Cam')
    cam_data.type = 'ORTHO'
    cam_data.ortho_scale = ORTHO
    cam = bpy.data.objects.new('Cam', cam_data)
    bpy.context.collection.objects.link(cam)

    fwd = Vector((math.cos(EL) * math.cos(AZ), -math.cos(EL) * math.sin(AZ), -math.sin(EL)))
    right = fwd.cross(Vector((0, 0, 1))).normalized()
    up = right.cross(fwd).normalized()
    cam.location = Vector((0.0, 0.0, 0.0)) - fwd * 40.0
    R = Matrix(((right.x, up.x, -fwd.x),
                (right.y, up.y, -fwd.y),
                (right.z, up.z, -fwd.z)))
    cam.rotation_euler = R.to_euler('XYZ')
    bpy.context.scene.camera = cam
    return cam, right, up, fwd


def setup_light():
    """Солнце с известным направлением (строим матрицу сами, не через track_quat)."""
    prop = -SUN_DIR                                   # локальный -Z смотрит по свету
    right = prop.cross(Vector((0, 0, 1)))
    if right.length < 1e-6:
        right = Vector((1, 0, 0))
    right.normalize()
    up = right.cross(prop).normalized()
    R = Matrix(((right.x, up.x, -prop.x),
                (right.y, up.y, -prop.y),
                (right.z, up.z, -prop.z)))
    ld = bpy.data.lights.new('Sun', 'SUN')
    ld.energy = SUN_ENERGY
    ld.angle = math.radians(4.0)
    sun = bpy.data.objects.new('Sun', ld)
    sun.rotation_euler = R.to_euler('XYZ')
    bpy.context.collection.objects.link(sun)

    w = bpy.data.worlds.new('World')
    bpy.context.scene.world = w
    w.use_nodes = True
    bg = w.node_tree.nodes['Background']
    bg.inputs['Color'].default_value = (*AMBIENT_COLOR, 1.0)
    bg.inputs['Strength'].default_value = AMBIENT_STRENGTH
    return sun


def setup_render(samples=64):
    sc = bpy.context.scene
    for eng in ('BLENDER_EEVEE', 'BLENDER_EEVEE_NEXT', 'CYCLES'):
        try:
            sc.render.engine = eng
            break
        except TypeError:
            continue
    sc.render.resolution_x = RES_X
    sc.render.resolution_y = RES_Y
    sc.render.resolution_percentage = 100
    sc.render.film_transparent = True
    sc.render.image_settings.file_format = 'PNG'
    sc.render.image_settings.color_mode = 'RGBA'
    sc.render.image_settings.color_depth = '8'
    sc.view_settings.view_transform = 'Standard'
    sc.view_settings.look = 'None'
    sc.view_settings.exposure = 0.0
    sc.view_settings.gamma = 1.0
    try:
        sc.eevee.taa_render_samples = samples
    except Exception:
        pass


def render_to(path):
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


# --------------------------------------------------------------------------
# ГЕОМЕТРИЯ
# --------------------------------------------------------------------------
def new_obj_from_bm(bm, name, mat):
    me = bpy.data.meshes.new(name)
    ob = bpy.data.objects.new(name, me)
    ob.data.materials.append(mat)
    bpy.context.collection.objects.link(ob)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = False
    return ob


def add_box(bm, x, y, z, sx, sy, sz, rot_z=0.0, rot_x=0.0, rot_y=0.0):
    """Короб: (x,y,z) — центр основания, размеры по осям, поворот вокруг основания."""
    mat = (Matrix.Translation((x, y, z)) @
           Matrix.Rotation(rot_z, 4, 'Z') @
           Matrix.Rotation(rot_y, 4, 'Y') @
           Matrix.Rotation(rot_x, 4, 'X') @
           Matrix.Translation((0, 0, sz / 2)) @
           Matrix.Diagonal((sx, sy, sz, 1.0)))
    bmesh.ops.create_cube(bm, size=1.0, matrix=mat)
    return bm


def add_prism(bm, poly_xy, z0, z1):
    """Вертикальная призма по 2D-контуру (список (x,y)), от z0 до z1."""
    verts = [bm.verts.new((x, y, z0)) for x, y in poly_xy]
    bm.verts.ensure_lookup_table()
    f = bm.faces.new(verts)
    bmesh.ops.recalc_face_normals(bm, faces=[f])
    r = bmesh.ops.extrude_face_region(bm, geom=[f])
    up = [e for e in r['geom'] if isinstance(e, bmesh.types.BMVert)]
    bmesh.ops.translate(bm, verts=up, vec=(0, 0, z1 - z0))
    return bm


def add_cone(bm, x, y, z, r1, r2, h, seg=8, rot_z=0.0):
    mat = (Matrix.Translation((x, y, z + h / 2)) @ Matrix.Rotation(rot_z, 4, 'Z'))
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=seg,
                          radius1=r1, radius2=r2, depth=h, matrix=mat)
    return bm


def add_ico(bm, x, y, z, rx, ry, rz, subdiv=1):
    mat = Matrix.Translation((x, y, z)) @ Matrix.Diagonal((rx, ry, rz, 1.0))
    bmesh.ops.create_icosphere(bm, subdivisions=subdiv, radius=1.0, matrix=mat)
    return bm


def add_quad(bm, pts):
    """Плоский четырёхугольник по 4 точкам (CCW)."""
    vs = [bm.verts.new(p) for p in pts]
    bm.verts.ensure_lookup_table()
    f = bm.faces.new(vs)
    bmesh.ops.recalc_face_normals(bm, faces=[f])
    return bm


def jitter(bm, amount=0.012, seed=1):
    """Лёгкая неровность: «срублено топором», а не станочная деталь."""
    import random
    rnd = random.Random(seed)
    for v in bm.verts:
        v.co.x += rnd.uniform(-amount, amount)
        v.co.y += rnd.uniform(-amount, amount)
        v.co.z += rnd.uniform(-amount, amount)
    return bm


def apply_transforms(objs):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    bpy.ops.object.select_all(action='DESELECT')


def stats():
    tris = 0
    verts = 0
    for o in bpy.context.scene.objects:
        if o.type != 'MESH':
            continue
        me = o.data
        verts += len(me.vertices)
        for p in me.polygons:
            tris += len(p.vertices) - 2
    return tris, verts
