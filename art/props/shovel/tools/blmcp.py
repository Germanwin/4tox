"""Клиент сокета аддона blender-mcp — связь с УЖЕ ЗАПУЩЕННЫМ Blender.

Аддон `addon.py` (Blender 5.2) держит TCP-сервер на 127.0.0.1:9876 и принимает
команды в формате JSON-фрейма: 4 байта длины (big-endian uint32) + JSON.
Ответ приходит тем же фреймом. Команда исполняется в главном потоке Blender
через `bpy.app.timers`, поэтому в GUI-сессии код виден в сцене сразу.

    python3 tools/blmcp.py info                 # что открыто в Blender
    python3 tools/blmcp.py run tools/foo.py     # исполнить файл внутри Blender
    python3 tools/blmcp.py shot out/view.png    # скриншот 3D-вьюпорта

Зачем: пайплайн скилла 4tox-lowpoly-3d обычно гоняют headless
(`blender -b --factory-startup -P ...`), но модель можно собрать и в живой
сессии — тогда её видно в вьюпорте и не надо перезапускать Blender.
ВАЖНО: код, который шлётся сюда, не должен звать `bpy.ops.wm.read_factory_settings`
(это снесёт сцену пользователя) — поэтому build_shovel.py умеет работать
в отдельной сцене, не трогая чужие объекты.
"""
import argparse
import base64
import json
import os
import socket
import struct
import sys

HOST = os.environ.get('BLENDER_MCP_HOST', '127.0.0.1')
PORT = int(os.environ.get('BLENDER_MCP_PORT', '9876'))
HDR = '>I'
MAX_FRAME = 64 * 1024 * 1024


def _recv_exact(sock, n):
    buf = b''
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError('Blender закрыл соединение')
        buf += chunk
    return buf


def send(command, timeout=1800.0):
    """Отправить команду аддону и вернуть распакованный ответ."""
    body = json.dumps(command).encode('utf-8')
    if len(body) > MAX_FRAME:
        raise ValueError('команда больше кадра (%d байт)' % len(body))
    with socket.create_connection((HOST, PORT), timeout=timeout) as sock:
        sock.settimeout(timeout)
        sock.sendall(struct.pack(HDR, len(body)) + body)
        (length,) = struct.unpack(HDR, _recv_exact(sock, 4))
        if length <= 0 or length > MAX_FRAME:
            raise ValueError('битый ответ: длина %d' % length)
        return json.loads(_recv_exact(sock, length).decode('utf-8'))


def execute(code, timeout=1800.0):
    """Выполнить python-код в Blender. Возвращает (ok, текст)."""
    r = send({'type': 'execute_code', 'params': {'code': code}}, timeout=timeout)
    if r.get('status') != 'success':
        return False, json.dumps(r, ensure_ascii=False, indent=1)
    res = r.get('result', {})
    return True, res.get('result', '')


def run_file(path, extra=(), timeout=1800.0):
    """Исполнить файл внутри Blender как __main__ (работают `if __name__`).

    `extra` кладётся в sys.argv после имени файла — так скрипты скилла читают
    свои `--флаги` (см. их `argv()`/`opt()`), а прежний sys.argv Blender
    восстанавливается после запуска.

    Перед запуском из `sys.modules` выкидываются модули проекта: Blender —
    долгоживущий процесс, и без сброса кэша правка shovel.py не подхватилась бы
    (сборка шла бы старым кодом — грабли, на которые легко наступить).
    """
    path = os.path.abspath(path)
    code = (
        "import sys as _sys\n"
        "for _n in ('shovel', 'build_shovel', 'build_live', 'scene', 'palette',\n"
        "           'color', 'thpipe', 'calib_render', 'calib_live', 'pview',\n"
        "           'verify_shovel'):\n"
        "    _sys.modules.pop(_n, None)\n"
        "_old_argv = _sys.argv[:]\n"
        "_sys.argv = [%r] + %r\n"
        "try:\n"
        "    exec(compile(open(%r, encoding='utf-8').read(), %r, 'exec'), "
        "{'__name__': '__main__', '__file__': %r})\n"
        "finally:\n"
        "    _sys.argv = _old_argv" % (path, list(extra), path, path, path))
    return execute(code, timeout=timeout)


def scene_info():
    return send({'type': 'get_scene_info'})


def screenshot(path=None, max_size=1400):
    """Скриншот 3D-вьюпорта в файл (offscreen-рендер области)."""
    r = send({'type': 'get_viewport_screenshot',
              'params': {'max_size': max_size}}, timeout=300.0)
    if r.get('status') != 'success':
        raise SystemExit('скриншот не вышел: %s' % json.dumps(r, ensure_ascii=False))
    res = r['result']
    if 'image_base64' not in res:
        raise SystemExit('скриншот без данных: %s' % json.dumps(res, ensure_ascii=False))
    if path:
        with open(path, 'wb') as f:
            f.write(base64.b64decode(res['image_base64']))
    return res


def main():
    ap = argparse.ArgumentParser(description='клиент сокета blender-mcp')
    sub = ap.add_subparsers(dest='cmd', required=True)
    sub.add_parser('info', help='состав открытой сцены')
    p_run = sub.add_parser('run', help='исполнить файл внутри Blender')
    p_run.add_argument('file')
    p_run.add_argument('extra', nargs=argparse.REMAINDER,
                       help='аргументы для скрипта (после --)')
    p_shot = sub.add_parser('shot', help='скриншот вьюпорта')
    p_shot.add_argument('png', nargs='?')
    p_code = sub.add_parser('code', help='исполнить строку кода')
    p_code.add_argument('text')
    args = ap.parse_args()

    if args.cmd == 'info':
        r = scene_info()
        res = r.get('result', r)
        print('Blender %s, сцена %r, объектов %s' % (
            res.get('blender_version_string'), res.get('name'), res.get('object_count')))
        for o in res.get('objects', []):
            print('  %-24s %-8s %s' % (o.get('name'), o.get('type'),
                                       o.get('location')))
        return
    if args.cmd == 'run':
        ok, out = run_file(args.file, args.extra)
        print(out, end='')
        sys.exit(0 if ok else 1)
    if args.cmd == 'shot':
        res = screenshot(args.png)
        print('скриншот %dx%d (%s) -> %s' % (res['width'], res['height'],
                                            res.get('method'), args.png or '(без файла)'))
        return
    if args.cmd == 'code':
        ok, out = execute(args.text)
        print(out, end='')
        sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
