# Прод 4tox: VPS, выкладка и откат

Игра стоит на VPS **`374412.fornex.cloud` (`213.239.158.37`)**, это тот же
сервер, что и naive VPN. Наружу игру отдаёт Caddy; Node слушает только
loopback. Никаких паролей в этом файле нет: доступ — по SSH-ключу.

## Доступ

```bash
ssh 4tox-vps          # запись в ~/.ssh/config: root@213.239.158.37
```

Ключ — `~/.ssh/naive_213` (создан для этого VPS, комментарий
`dsh-naive@213.239.158.37`). Пользователь `root`. Алиас и ключ живут только на
машине разработчика, в репозиторий не попадают.

## Что где

| Что | Где |
|---|---|
| Код игры | `/opt/4tox` — только `game/`, `mapgen2/` и `COMMIT`; **git там нет** |
| Служба игры | `4tox.service`, `User=4tox`, `WorkingDirectory=/opt/4tox` |
| Запуск | `/opt/node/bin/node game/server/server.js --host 127.0.0.1 --port 8787 --no-upnp --public-url https://374412.fornex.cloud/game/` |
| Обратный прокси | `caddy-naive.service`, `/etc/caddy/Caddyfile`; он же naive forwardproxy |
| Публичный адрес | https://374412.fornex.cloud/game/ |
| Сборка для `/api/build` | файл `/opt/4tox/COMMIT` (или env `BUILD_ID`/`GIT_COMMIT`) |
| Бэкапы выкладок | `/root/4tox-backup-*.tgz`, хеши «до» — `/root/4tox-before-md5-*.txt` |

Caddy проксирует `handle /game/*`, `/mapgen2/*`, `/api/*` на
`127.0.0.1:8787` с `flush_interval -1` (без него SSE копит события).
Статика и атласы идут через тот же Node; `game/tools`, `mapgen2/tools`,
`research/` и `.git` на прод **не копируются**.

## Выкладка

1. В локальной рабочей копии зафиксировать коммит и собрать staging **только
   из отдаваемых файлов** (без `tools/`):

   ```bash
   COMMIT=$(git rev-parse --short=12 HEAD)
   STAGE=/tmp/4tox-deploy-$COMMIT
   rm -rf "$STAGE"; mkdir -p "$STAGE/game" "$STAGE/mapgen2"
   cp -a game/README.md game/assets game/css game/index.html game/js \
         game/server game/Мультиплеер.command "$STAGE/game/"
   cp -a mapgen2/PATHFINDING.md mapgen2/README.md mapgen2/assets \
         mapgen2/css mapgen2/index.html mapgen2/js "$STAGE/mapgen2/"
   printf '%s\n' "$COMMIT" > "$STAGE/COMMIT"
   ```

2. Обязательный dry-run: удалений в `/opt/4tox` быть не должно.

   ```bash
   rsync -rlptn --checksum --delete --itemize-changes \
     -e "ssh -i ~/.ssh/naive_213" "$STAGE/game/" \
     root@213.239.158.37:/opt/4tox/game/
   # и то же для mapgen2/
   ```

3. Бэкап текущего прода (9–10 МБ):

   ```bash
   ssh root@213.239.158.37 \
     'tar czf /root/4tox-backup-$(date +%Y%m%d-%H%M%S).tgz -C /opt 4tox'
   ```

4. Выкладка, `COMMIT`, владелец, рестарт **только игры**:

   ```bash
   rsync -rlpt --checksum --delete -e "ssh -i ~/.ssh/naive_213" \
     "$STAGE/game/" root@213.239.158.37:/opt/4tox/game/
   rsync -rlpt --checksum --delete -e "ssh -i ~/.ssh/naive_213" \
     "$STAGE/mapgen2/" root@213.239.158.37:/opt/4tox/mapgen2/
   ssh root@213.239.158.37 "
     printf '%s\n' $COMMIT > /opt/4tox/COMMIT
     chown -R 4tox:4tox /opt/4tox
     systemctl restart 4tox.service"
   ```

   **Caddy не перезапускать.** Он обслуживает и naive VPN; конфиг Caddy для
   игры не меняется.

5. Проверка:

   ```bash
   curl -s https://374412.fornex.cloud/api/build      # build/protocol
   curl -s -o /dev/null -w '%{http_code}\n' https://374412.fornex.cloud/game/
   curl -s -o /dev/null -w '%{http_code}\n' https://374412.fornex.cloud/game/js/pending.js
   ssh root@213.239.158.37 'systemctl is-active 4tox caddy-naive; journalctl -u 4tox -n 20 --no-pager'
   ```

   Полезный smoke без браузера: лобби на двух игроков, оба `ready`,
   `/api/start`, SSE с `Accept-Encoding: gzip`, снимок, команда гостя
   (`ageMs`), `cmdDone` хоста с `ids/appliedSeq`, `/api/command-state`,
   `/api/diag` и `/api/stream-stats` хосту (гостю — 403). Сжатое тело снимка
   (`Content-Encoding: gzip`) сервер должен принять с `gzip:true` в ответе.

## Откат

```bash
ssh root@213.239.158.37 '
  tar xzf /root/4tox-backup-<TS>.tgz -C /opt
  chown -R 4tox:4tox /opt/4tox
  systemctl restart 4tox.service'
```

Старый `COMMIT` вернуть вручную (или удалить файл — тогда `/api/build`
покажет `dev`). Проверить `/api/build`, `/game/`, журнал службы.

## Факт выкладки 2026-10-26 22:41 MSK

- Было: база `dc75820` (на проде не было даже `/api/build`); `net.js`
  md5 `b94b687a…`, `server.js` md5 `058ef081…`.
- Стало: **build `1d842c45423d`, protocol 3, cmdProto 2**; `net.js`
  `7b4cba27…`, `server.js` `f77c62ed…`, `pending.js` `1ed74149…`,
  `combat.js` `0b8aa733…`.
- Бэкап: `/root/4tox-backup-20261026-224117.tgz` (9.8 МБ).
- `4tox.service` active, `NRestarts=0`; `caddy-naive` active, конфиг Valid.
- Публичный smoke (23 проверки): лобби, старт, SSE gzip, снимок, команда с
  `ageMs`, результат `applied` с `ids/appliedSeq`, diag/stream-stats, отказ
  гостю в diag, warning старому протоколу без отказа, gzip-тело снимка.
- Браузер (headless Chrome, публичный домен): загрузка, `pending.js`, 3
  жителя, режим `play`, исключений страницы нет. Единственная ошибка
  консоли — `/favicon.ico` 404 (была и до патча).
