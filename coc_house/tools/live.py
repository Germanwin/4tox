"""Минимальный клиент сокета аддона blender-mcp (127.0.0.1:9876).

Кадр: 4 байта длины (big-endian uint32) + JSON. Команда исполняется в главном
потоке Blender, поэтому результат сразу виден в сцене заказчика.

    python3 tools/live.py info                 # состав открытой сцены
    python3 tools/live.py run tools/build.py   # исполнить файл внутри Blender
    python3 tools/live.py code "print(1)"      # строка python внутри Blender
"""
import argparse
import json
import os
import socket
import struct
import sys

HOST = os.environ.get('COC_MCP_HOST', '127.0.0.1')
PORT = int(os.environ.get('COC_MCP_PORT', '9876'))
HDR = '>I'
MAX = 64 * 1024 * 1024


def _recv(sock, n):
    buf = b''
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError('Blender закрыл соединение')
        buf += chunk
    return buf


def send(command, timeout=1800.0):
    body = json.dumps(command).encode('utf-8')
    if len(body) > MAX:
        raise ValueError('команда больше кадра')
    with socket.create_connection((HOST, PORT), timeout=timeout) as sock:
        sock.settimeout(timeout)
        sock.sendall(struct.pack(HDR, len(body)) + body)
        (length,) = struct.unpack(HDR, _recv(sock, 4))
        if length <= 0 or length > MAX:
            raise ValueError('битый ответ: %d' % length)
        return json.loads(_recv(sock, length).decode('utf-8'))


def execute(code, timeout=1800.0):
    r = send({'type': 'execute_code', 'params': {'code': code}}, timeout=timeout)
    ok = r.get('status') == 'success'
    res = r.get('result')
    if isinstance(res, dict):
        text = res.get('result') or res.get('message') or json.dumps(res)
    else:
        text = str(res)
    return ok, text


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('cmd', choices=['info', 'run', 'code'])
    ap.add_argument('arg', nargs='?')
    a = ap.parse_args()

    if a.cmd == 'info':
        ok, out = execute('import json,bpy\n'
                          'print(json.dumps({"scene": bpy.context.scene.name,'
                          ' "background": bpy.app.background,'
                          ' "objects": [o.name for o in bpy.data.objects]}))')
    elif a.cmd == 'run':
        with open(a.arg, 'r', encoding='utf-8') as fh:
            ok, out = execute(fh.read())
    else:
        ok, out = execute(a.arg)

    print(out)
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
