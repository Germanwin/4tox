/* net-config.js — единые сетевые числа клиента и сервера.

   Числа протокола не должны жить двумя копиями: браузер и Node обязаны
   считать одинаково, иначе «20 тиков в секунду» на сервере превратятся в
   «19,9» у клиента и интерполяция начнёт систематически недоигрывать.

   Модуль нарочно без зависимостей и без сборщика: в браузере он грузится
   обычным <script> до play.js, в Node — через require. Одно и то же число
   доступно и как `globalThis.NetConfig`, и как `module.exports`. */
(function (global) {
  'use strict';

  var NET_CONFIG = Object.freeze({
    protocol: 4,
    commandProtocol: 3,
    tickMs: 50,
    snapshotEveryTicks: 2,
    interpolationDelayMs: 150,
    maxExtrapolationMs: 100,
    snapshotBufferSize: 32,
    staleAfterMs: 500,
    schedulerMaxStepsPerTurn: 4,
    schedulerBudgetMs: 8,
    heartbeatMs: 2000,
    commandBodyMaxBytes: 16384,
    commandMaxIds: 200,
    buildLineMaxItems: 64,
    commandQueuePerPlayer: 64,
    commandQueuePerRoom: 256,
    commandsPerTick: 64,
    pendingMax: 60,
    controlQueueMaxBytes: 262144,
    streamQueueMaxBytes: 2097152,
    slowClientTimeoutMs: 5000,
    checkpointEveryTicks: 200,
    emptyRoomGraceMs: 600000,
    /* Производные величины. Считаются от tickMs, чтобы ни у кого не было
       собственного «0.05» рядом с конфигом. */
    tickSeconds: 50 / 1000,
    snapshotsPerSecond: 1000 / (50 * 2)
  });

  global.NetConfig = NET_CONFIG;
  if (typeof module !== 'undefined' && module.exports) module.exports = NET_CONFIG;
})(typeof window !== 'undefined' ? window : globalThis);
