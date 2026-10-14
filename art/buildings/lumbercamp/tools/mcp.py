"""mcp.py — клиент сокета аддона blender-mcp: связь с УЖЕ ЗАПУЩЕННЫМ Blender.

Запускается снаружи Blender обычным питоном:

    $PY tools/mcp.py info                       # что открыто в Blender
    $PY tools/mcp.py run tools/build_live.py    # исполнить файл ВНУТРИ Blender
    $PY tools/mcp.py shot renders/view.png      # скриншот 3D-вьюпорта
    $PY tools/mcp.py code "print(bpy.app.version_string)"

Аддон держит TCP-сервер на 127.0.0.1:9876 и принимает команды кадром
«4 байта длины (big-endian uint32) + JSON».  Команда исполняется в главном
потоке Blender через `bpy.app.timers`, поэтому результат виден в сцене сразу,
и вложенное соединение к тому же сокету из исполняемого кода встанет намертво —
скриншот снимается ОТДЕЛЬНОЙ командой, а не из сборки.

Если сокет замолчал (ConnectionRefusedError), а окно Blender живо — в Blender
нужно нажать N, вкладку Blender MCP и Connect to MCP server.
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

# Модули проекта, которые надо выкинуть из кэша перед запуском файла: Blender —
# долгоживущий процесс, и без сброса правка генератора не подхватится (сборка
# молча пойдёт старым кодом — грабли, на которые легко наступить).
RELOAD = ('forge', 'building', 'blender_live', 'xray', 'canon', 'palette',
          'scene', 'build')


def _recv_exact(sock, n):
    buf = b''
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError('Blender закрыл соединение')
        buf += chunk
    return buf


def send(command, timeout=1800.0):
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
    r = send({'type': 'execute_code', 'params': {'code': code}}, timeout=timeout)
    if r.get('status') != 'success':
        return False, json.dumps(r, ensure_ascii=False, indent=1)
    return True, r.get('result', {}).get('result', '')


def run_file(path, extra=(), timeout=1800.0):
    """Исполнить файл внутри Blender как __main__ (работают `if __name__`).

    `extra` кладётся в sys.argv после имени файла — так скрипты читают свои
    `--флаги`, а прежний sys.argv Blender восстанавливается после запуска.
    """
    path = os.path.abspath(path)
    code = (
        "import sys as _sys\n"
        "for _n in %r:\n"
        "    _sys.modules.pop(_n, None)\n"
        "_old_argv = _sys.argv[:]\n"
        "_sys.argv = [%r] + %r\n"
        "try:\n"
        "    exec(compile(open(%r, encoding='utf-8').read(), %r, 'exec'), "
        "{'__name__': '__main__', '__file__': %r})\n"
        "finally:\n"
        "    _sys.argv = _old_argv" % (list(RELOAD), path, list(extra), path,
                                     path, path))
    return execute(code, timeout=timeout)


def scene_info():
    return send({'type': 'get_scene_info'})


def screenshot(path=None, max_size=1400):
    """Скриншот 3D-вьюпорта (offscreen-рендер области)."""
    r = send({'type': 'get_viewport_screenshot',
              'params': {'max_size': max_size}}, timeout=300.0)
    if r.get('status') != 'success':
        raise SystemExit('скриншот не вышел: %s'
                         % json.dumps(r, ensure_ascii=False))
    res = r['result']
    if 'image_base64' not in res:
        raise SystemExit('скриншот без данных')
    if path:
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        with open(path, 'wb') as f:
            f.write(base64.b64decode(res['image_base64']))
    return res


def main():
    ap = argparse.ArgumentParser(description='клиент сокета blender-mcp')
    sub = ap.add_subparsers(dest='cmd', required=True)
    sub.add_parser('info')
    p_run = sub.add_parser('run')
    p_run.add_argument('file')
    p_run.add_argument('extra', nargs=argparse.REMAINDER)
    p_shot = sub.add_parser('shot')
    p_shot.add_argument('png', nargs='?')
    p_code = sub.add_parser('code')
    p_code.add_argument('text')
    args = ap.parse_args()

    if args.cmd == 'info':
        res = scene_info().get('result', {})
        print('Blender %s, сцена %r, объектов %s'
              % (res.get('blender_version_string'), res.get('name'),
                 res.get('object_count')))
        for o in res.get('objects', []):
            print('  %-24s %-8s %s' % (o.get('name'), o.get('type'),
                                       o.get('location')))
        return
    if args.cmd == 'run':
        extra = [a for a in args.extra if a != '--']
        ok, out = run_file(args.file, extra)
        print(out, end='')
        sys.exit(0 if ok else 1)
    if args.cmd == 'shot':
        res = screenshot(args.png)
        print('скриншот %dx%d -> %s' % (res['width'], res['height'],
                                        args.png or '(без файла)'))
        return
    ok, out = execute(args.text)
    print(out, end='')
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
