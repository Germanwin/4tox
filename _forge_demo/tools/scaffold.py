"""scaffold.py — создать проект постройки из шаблонов скилла.

    $PY3 scripts/scaffold.py ~/coding/4tox/smithy --scene smithy --prefix sm_

Кладёт в проект СВОИ копии инструментов (проект должен быть самодостаточным:
через год скилл может уехать, а проект останется), шаблон генератора, точку
входа в живой Blender, три конфига съёмки и README-заготовку.

Почему копии, а не импорт из скилла: сборка гоняется внутри Blender, и путь до
скилла придётся помнить в каждом запуске; а ещё правка инструмента под конкретную
постройку — нормальный ход, и она не должна менять скилл для всех остальных.
"""
import argparse
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL = os.path.dirname(HERE)
SCRIPTS = os.path.join(SKILL, 'scripts')
TEMPLATES = os.path.join(SKILL, 'templates')

COPY_SCRIPTS = ('forge.py', 'xray.py', 'canon.py', 'blender_live.py', 'mcp.py',
                'compose.py')
COPY_TEMPLATES = ('building.py', 'build_live.py')


def write(path, text, force=False):
    if os.path.exists(path) and not force:
        print('  = %s (уже есть)' % path)
        return False
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(text)
    print('  + %s' % path)
    return True


def main():
    ap = argparse.ArgumentParser(description='новый проект постройки')
    ap.add_argument('dst', help='каталог проекта')
    ap.add_argument('--scene', default=None, help='имя сцены в Blender')
    ap.add_argument('--prefix', default=None, help='префикс имён объектов')
    ap.add_argument('--ppu', type=float, default=80.0)
    ap.add_argument('--force', action='store_true', help='перезаписать файлы')
    args = ap.parse_args()

    dst = os.path.abspath(os.path.expanduser(args.dst))
    name = os.path.basename(dst.rstrip('/')) or 'building'
    scene = args.scene or name
    prefix = args.prefix or (''.join(w[0] for w in name.split('_')) + '_')
    print('проект %s\n  сцена %r, префикс %r' % (dst, scene, prefix))

    for sub in ('tools', 'renders', 'out'):
        os.makedirs(os.path.join(dst, sub), exist_ok=True)
    for f in COPY_SCRIPTS:
        src, dstdir = os.path.join(SCRIPTS, f), os.path.join(dst, 'tools')
        if os.path.exists(os.path.join(dstdir, f)) and not args.force:
            print('  = tools/%s (уже есть)' % f)
            continue
        shutil.copy2(src, os.path.join(dstdir, f))
        print('  + tools/%s' % f)
    for f in COPY_TEMPLATES:
        src = os.path.join(TEMPLATES, f)
        out = os.path.join(dst, 'tools', f)
        if os.path.exists(out) and not args.force:
            print('  = tools/%s (уже есть)' % f)
            continue
        shutil.copy2(src, out)
        print('  + tools/%s (шаблон — правь под свою постройку)' % f)

    base = dict(scene=scene, prefix=prefix, variants=[None],
                rotations=[0, 90, 180, 270], ppu=args.ppu, res=[512, 640],
                samples=64, export=False, save_blend=False, viewport=True,
                tag=prefix.rstrip('_'), closeups=False)
    import json
    write(os.path.join(dst, 'live_config.json'),
          json.dumps(base, ensure_ascii=False, indent=1) + '\n', args.force)
    gate = dict(base, rotations=[0, 90, 180, 270], ppu=96.0,
                tag=prefix.rstrip('_') + 'g')
    write(os.path.join(dst, 'live_gate.json'),
          json.dumps(gate, ensure_ascii=False, indent=1) + '\n', args.force)
    x4 = dict(base, rotations=[0], ppu=384.0, res=[2048, 2560],
              tag=prefix.rstrip('_') + '4x', viewport=False)
    write(os.path.join(dst, 'live_4x.json'),
          json.dumps(x4, ensure_ascii=False, indent=1) + '\n', args.force)
    exp = dict(base, rotations=[], export=True, save_blend=True, viewport=True)
    write(os.path.join(dst, 'live_export.json'),
          json.dumps(exp, ensure_ascii=False, indent=1) + '\n', args.force)

    readme = README.format(name=name, scene=scene, prefix=prefix,
                           ppu=int(args.ppu))
    write(os.path.join(dst, 'README.md'), readme, args.force)
    print('\nдальше:\n'
          '  cd %s\n'
          '  $PY3 tools/canon.py --gen tools/building.py     # приёмка по канону\n'
          '  $PY3 tools/xray.py probe --gen tools/building.py --full\n'
          '  $PY tools/mcp.py run tools/build_live.py        # сборка в живом Blender'
          % dst)
    return 0


README = """# {name} — постройка для 4tox/mapgen2

Собрано по скиллу `4tox-building-forge`.  Сцена Blender `{scene}`, префикс имён
`{prefix}`, кадр {ppu} ppu (изометрия 2:1).

## Инструменты (копии из скилла, можно править под эту постройку)

| файл | что делает |
|---|---|
| `tools/building.py` | ГЕОМЕТРИЯ: чистый Python, ярусы и раскладка. Главный файл. |
| `tools/forge.py` | примитивы, отсев невидимых фасетов, триангуляция, палитра |
| `tools/xray.py` | софт-рендер и детектор дефектов (изнанки, зазоры, z-fighting) |
| `tools/canon.py` | приёмка по канону: ярусы, габарит, уклон, свесы, бюджет, нормали |
| `tools/blender_live.py` | материалы, свет, камера, рендер, экспорт (внутри Blender) |
| `tools/build_live.py` | точка входа сборки в живом Blender |
| `tools/mcp.py` | клиент сокета аддона blender-mcp (снаружи Blender) |
| `tools/compose.py` | сырой кадр -> спрайт: обрезка, контур, контактная тень |

## Порядок работы

```bash
PY=/Users/hermmoment/.dsh/profiles/desktop/node_modules/dsh-blender/.venv/bin/python
PY3=/Users/hermmoment/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3

$PY3 tools/canon.py --gen tools/building.py        # числа против канона
$PY3 tools/xray.py probe --gen tools/building.py --full   # дефекты, 32 ракурса
$PY  tools/mcp.py run tools/build_live.py          # сборка в УЖЕ ЗАПУЩЕННОМ Blender
$PY  tools/mcp.py shot renders/live.png            # посмотреть вьюпорт

# спрайт и гейт кадра (гейт гоняется и на 1x, и на @4x)
$PY3 tools/compose.py --raw renders/<тег>_x_0_raw.png --out out/<тег>_0.png --ppu 96
$PY3 <4tox-lowpoly-3d>/scripts/audit.py --mine out/<тег>_0.png --kind building \
     --ppu 96 --anchor <X,Y> --tris <трис>            # ждём 0 FAIL, 0 WARN
```

## Что дальше по пайплайну

Спрайты и атлас собираются пост-обработкой (контур, контактная тень, обрезка) —
см. `4tox-lowpoly-3d/references/pipeline.md`; приёмка кадра — `scripts/audit.py`
того же скилла (порог палитры 93%, детализации, контура, тени, полигонажа).
"""


if __name__ == "__main__":
    sys.exit(main())
