'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./load-engine');

const ASSETS = [
  ['sprites', 'MOBILE_SPRITE_ATLAS', 'SPRITE_ATLAS'],
  ['waves', 'MOBILE_WAVE_ATLAS', 'WAVE_ATLAS'],
  ['villager', 'MOBILE_VILLAGER_ATLAS', 'VILLAGER_ATLAS'],
  ['armored_villager', 'MOBILE_ARMORED_VILLAGER_ATLAS', 'ARMORED_VILLAGER_ATLAS'],
  ['townhall', 'MOBILE_TOWNHALL_ATLAS', 'TOWNHALL_ATLAS'],
  ['starter_house', 'MOBILE_STARTER_HOUSE_ATLAS', 'STARTER_HOUSE_ATLAS'],
  ['lumbercamp', 'MOBILE_LUMBERCAMP_ATLAS', 'LUMBERCAMP_ATLAS'],
  ['barracks', 'MOBILE_BARRACKS_ATLAS', 'BARRACKS_ATLAS'],
  ['warcamp', 'MOBILE_WARCAMP_ATLAS', 'WARCAMP_ATLAS'],
  ['ruins', 'MOBILE_RUINS_ATLAS', 'RUINS_ATLAS']
];

function qualityWith(env) {
  const old = {
    Quality: globalThis.Quality, devicePixelRatio: globalThis.devicePixelRatio,
    matchMedia: globalThis.matchMedia, localStorage: globalThis.localStorage,
    navigator: globalThis.navigator
  };
  globalThis.devicePixelRatio = env.dpr || 1;
  globalThis.matchMedia = () => ({ matches: !!env.coarse });
  try {
    Object.defineProperty(globalThis, 'navigator', {
      value: { maxTouchPoints: env.coarse ? 5 : 0 }, configurable: true
    });
  } catch (e) { /* Node's navigator getter */ }
  globalThis.localStorage = {
    getItem: () => null, setItem: () => {}, removeItem: () => {}
  };
  delete require.cache[require.resolve('../../js/quality.js')];
  globalThis.Quality = undefined;
  require('../../js/quality.js');
  return {
    Q: globalThis.Quality,
    restore: () => {
      globalThis.Quality = old.Quality;
      for (const k of ['devicePixelRatio', 'matchMedia', 'localStorage', 'navigator']) {
        if (old[k] === undefined) { try { delete globalThis[k]; } catch (e) {} }
        else { try { globalThis[k] = old[k]; } catch (e) {} }
      }
    }
  };
}

test('quality: auto/low/high и coarse pointer', () => {
  const q = qualityWith({ dpr: 3, coarse: false });
  assert.equal(q.Q.dprCap(), 2);
  assert.equal(q.Q.useMobile(), false);
  q.Q.set('low');
  assert.equal(q.Q.dprCap(), 1);
  assert.equal(q.Q.useMobile(), true);
  q.Q.set('high');
  assert.equal(q.Q.dprCap(), 2);
  q.Q.set('auto');
  q.restore();

  const c = qualityWith({ dpr: 3, coarse: true });
  assert.equal(c.Q.dprCap(), 1.5);
  assert.equal(c.Q.useMobile(), true);
  c.restore();
});

test('renderer не поднимает DPR выше 2 даже по просьбе', () => {
  const code = fs.readFileSync(path.join(ROOT, 'mapgen2/js/render.js'), 'utf8');
  if (!globalThis.Render) {
    new Function('window', 'document', 'globalThis', code)(undefined, undefined, globalThis);
  }
  const r = Object.create(globalThis.Render.Renderer.prototype);
  r.quality = 1; r.dprCap = 2; r.dpr = 1; r.canvas = null;
  r.setQuality(1, 3);
  assert.equal(r.dprCap, 2);
});

function pngSize(file) {
  const b = fs.readFileSync(file);
  assert.equal(b.toString('ascii', 1, 4), 'PNG');
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

test('mobile-атласы: метаданные половинные, footprint/ground не тронуты', () => {
  for (const [dir, , ] of ASSETS) {
    const desk = JSON.parse(fs.readFileSync(path.join(ROOT, 'mapgen2/assets', dir, 'atlas.json'), 'utf8'));
    const mob = JSON.parse(fs.readFileSync(path.join(ROOT, 'mapgen2/assets', dir, 'mobile/atlas.json'), 'utf8'));
    assert.ok(mob.mobile, dir + ': mobile flag');
    assert.equal(mob.mobileScale, 0.5);
    assert.ok(Math.abs(mob.ppu - desk.ppu * 0.5) < 1e-9, dir + ': ppu half');
    assert.equal(Object.keys(mob.frames).length, Object.keys(desk.frames).length, dir + ': frames');
    for (const key of Object.keys(desk.frames)) {
      const a = desk.frames[key], b = mob.frames[key];
      assert.equal(b.w, Math.max(1, Math.round(a.w * 0.5)), dir + ' ' + key + ' w');
      assert.equal(b.h, Math.max(1, Math.round(a.h * 0.5)), dir + ' ' + key + ' h');
      assert.ok(Math.abs(b.anchorX - a.anchorX * 0.5) < 1e-6, dir + ' ' + key + ' anchorX');
      assert.ok(Math.abs(b.anchorY - a.anchorY * 0.5) < 1e-6, dir + ' ' + key + ' anchorY');
      assert.deepEqual(b.footprint, a.footprint, dir + ' ' + key + ' footprint');
      assert.deepEqual(b.ground, a.ground, dir + ' ' + key + ' ground');
    }
    const ds = pngSize(path.join(ROOT, 'mapgen2/assets', dir, 'atlas.png'));
    const ms = pngSize(path.join(ROOT, 'mapgen2/assets', dir, 'mobile/atlas.png'));
    const ratio = (ds.w * ds.h) / (ms.w * ms.h);
    assert.ok(ratio > 2.5, dir + ': decoded area ~4x, ratio ' + ratio.toFixed(2));
  }
});

test('mobile atlas.js объявляет отдельное глобальное имя', () => {
  for (const [dir, mobileName] of ASSETS) {
    const text = fs.readFileSync(path.join(ROOT, 'mapgen2/assets', dir, 'mobile/atlas.js'), 'utf8');
    assert.match(text, new RegExp('window\\.' + mobileName + '\\s*='), dir);
    assert.match(fs.readFileSync(path.join(ROOT, 'game/js/atlas-tags.js'), 'utf8'),
      /mobile\/atlas\.js/);
    assert.match(fs.readFileSync(path.join(ROOT, 'game/index.html'), 'utf8'),
      /js\/atlas-tags\.js/);
  }
});

test('assetStats считает уникальные decoded-пиксели и canvas отдельно', () => {
  const code = fs.readFileSync(path.join(ROOT, 'mapgen2/js/render.js'), 'utf8');
  if (!globalThis.Render) {
    new Function('window', 'document', 'globalThis', code)(undefined, undefined, globalThis);
  }
  const R = globalThis.Render.Renderer.prototype;
  const r = Object.create(R);
  const img = { width: 10, height: 20 };
  r.sprites = { img: img };
  r.waveSprites = { img: img };
  r.villagerSprites = null; r.knightSprites = null;
  r.buildingSets = {}; r.ruinSets = {}; r.textures = {};
  r.canvas = { width: 100, height: 50 };
  r.cache = { canvas: { width: 10, height: 10 } };
  r.dpr = 1; r.dprCap = 2;
  const s = r.assetStats();
  assert.equal(s.count, 1);
  assert.equal(s.decodedBytesEstimate, 10 * 20 * 4);
  assert.deepEqual(s.main, { w: 100, h: 50, bytes: 100 * 50 * 4 });
  assert.deepEqual(s.cache, { w: 10, h: 10, bytes: 10 * 10 * 4 });
});
