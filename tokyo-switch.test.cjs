const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

let TokyoSwitch;
const window = { devicePixelRatio: 1 };
vm.runInNewContext(readFileSync(`${__dirname}/tokyo-switch.js`, 'utf8'), {
  HTMLElement: class {
    attachShadow() {
      return { querySelector: () => ({ style: {}, addEventListener() {} }) };
    }
  },
  customElements: { get() {}, define(name, component) { TokyoSwitch = component; } },
  matchMedia: () => ({ matches: true }),
  window,
});

test('resizing preserves the scene framing across screen densities and former zoom thresholds', () => {
  const el = new TokyoSwitch();
  el.initGl = () => {};
  for (const dpr of [1, 2, 3]) {
    window.devicePixelRatio = dpr;
    for (const width of [120, 327, 347, 348, 433, 434, 616, 617, 680]) {
      el.getBoundingClientRect = () => ({ width, height: width / 2 });
      el.resize();
      const s = el.shape;
      assert.ok(Math.abs(s.winH / s.k - 150) < 1e-9, `${width}px at ${dpr}x changed scene height`);
      assert.ok(Math.abs((s.W / 2 - s.ox) / s.k - 200) < 1e-9, 'horizontal framing moved');
      assert.ok(Math.abs((s.oy - s.H / 2 + s.winH / 2) / s.k - 190) < 1e-9, 'street framing moved');
    }
  }
});

function nightWorld() {
  const w = new TokyoSwitch().world;
  w.cars.forEach((car, i) => { car.x = [40, 220, 140, 270][i]; });
  w.peds = [Object.assign(w.peds[0], { x: 230, y: 123, style: 'coat', nightOnly: false })];
  w.tick(0, 22, { calm: true });
  w.compose(22);
  return w;
}

const pixel = (x, y) => ((y + 40) * 400 + x + 40) * 4;
const samples = [[229, 131], [152, 142], [282, 142], [231, 118]];

test('street reflections and their glow preserve car and pedestrian pixels', () => {
  const w = nightWorld();
  const before = w.rgba.slice();
  const beforeEmit = w.emit.slice();
  w.reflect();
  for (const [x, y] of samples) {
    const i = pixel(x, y);
    assert.deepEqual(w.rgba.slice(i, i + 4), before.slice(i, i + 4), `reflection covered an actor at ${x},${y}`);
    assert.deepEqual(w.emit.slice(i, i + 4), beforeEmit.slice(i, i + 4), `reflection glow covered an actor at ${x},${y}`);
  }
  assert.notDeepEqual(w.rgba, before, 'wet streets should still reflect light');
  assert.notDeepEqual(w.emit, beforeEmit, 'wet streets should still feed the glow');
});

test('headlight pools light the road without painting over cars', () => {
  const w = nightWorld();
  const before = w.rgba.slice();
  w.drawBeams([[283, 142, -1]]);
  const i = pixel(282, 142);
  assert.deepEqual(w.rgba.slice(i, i + 4), before.slice(i, i + 4));
  assert.notDeepEqual(w.rgba, before, 'headlights should still light the road');
});
