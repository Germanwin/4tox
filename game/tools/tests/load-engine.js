/* load-engine.js — общий загрузчик движка для node:test.

   Движок — те же IIFE, что в браузере. Тест грузит их в globalThis, не
   подсовывая ни document, ни Image, ни renderer. Это и есть проверка, что
   симуляция действительно не зависит от представления. */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function loadEngine() {
  if (globalThis.__4toxLoaded) return globalThis;
  globalThis.NetConfig = require(path.join(ROOT, 'game', 'shared', 'net-config.js'));
  globalThis.GameplayConfig = require(path.join(ROOT, 'mapgen2', 'js', 'simulation', 'gameplay-config.js'));
  const files = [
    'mapgen2/js/noise.js',
    'mapgen2/js/rng.js',
    'mapgen2/js/events.js',
    'mapgen2/js/worldgen.js',
    'mapgen2/js/hero.js',
    'mapgen2/js/buildings.js',
    'mapgen2/js/villager.js',
    'mapgen2/js/session.js',
    'mapgen2/js/combat.js',
    'mapgen2/js/army.js',
    'mapgen2/js/serialize.js',
    'mapgen2/js/simulation/navigation.js',
    'mapgen2/js/simulation/checkpoint.js',
    'mapgen2/js/simulation/commands.js',
    'mapgen2/js/simulation/simulation.js',
    'mapgen2/js/simulation/replication.js'
  ];
  for (const rel of files) {
    const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    new Function('window', 'document', 'globalThis',
      code + '\n//# sourceURL=' + rel)(undefined, undefined, globalThis);
  }
  globalThis.__4toxLoaded = true;
  return globalThis;
}

function makeSim(opts) {
  loadEngine();
  return globalThis.Simulation.create(Object.assign({
    seed: 'тихая-пойма-123',
    size: 64,
    players: 2,
    mode: 'multi',
    gameplay: globalThis.GameplayConfig
  }, opts || {}));
}

function command(over) {
  return Object.assign({
    protocol: 4, roomId: 'TEST', epoch: 1,
    commandId: 's0-test:1', clientSequence: 1, owner: 0,
    type: 'build',
    payload: { buildingType: 'house', variant: 'a', rot: 0, x: 40, y: 40 }
  }, over || {});
}

module.exports = { ROOT, loadEngine, makeSim, command };
