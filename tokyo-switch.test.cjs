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

function luminance(rgb) {
  const linear = Array.from(rgb, value => {
    const v = value / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

test('night car bodies remain distinct from unlit asphalt', () => {
  const w = nightWorld();
  const road = pixel(-30, 134);
  const roadLuminance = luminance(w.rgba.slice(road, road + 3));
  for (const car of w.cars) {
    const y = car.lane === 0 ? 136 : 147;
    const i = pixel(car.x + Math.floor(car.len / 2), y - 5);
    const bodyLuminance = luminance(w.rgba.slice(i, i + 3));
    assert.ok((bodyLuminance + 0.05) / (roadLuminance + 0.05) >= 2, `${car.kind} body disappears into the road`);
  }
});

test('road ripples stay behind cars', () => {
  const w = nightWorld();
  w.rainDrops = [];
  w.ripples = [{ x: 282, y: 142, a: 0.8 }, { x: 260, y: 142, a: 0.8 }];
  const before = w.rgba.slice();
  w.drawRain(0);
  const i = pixel(282, 142);
  assert.deepEqual(w.rgba.slice(i, i + 4), before.slice(i, i + 4));
  assert.notDeepEqual(w.rgba, before, 'ripples should still appear on the road');
});

test('neon signs leave a pixel between wide letters and center the full text', () => {
  for (const [text, width] of [['RAMEN', 28], ['NIGHT', 25], ['SNACK', 25], ['HOTEL', 26]]) {
    const w = new TokyoSwitch().world;
    const draws = [];
    const glyph = w.glyph.bind(w);
    w.glyph = (ch, x, y, paint) => {
      const width = glyph(ch, x, y, paint);
      draws.push({ x, width });
      return width;
    };
    w.hsign(0, 0, width, 11, text, { n: 0, g: 0 });
    for (let i = 1; i < draws.length; i++) {
      assert.equal(draws[i].x - (draws[i - 1].x + draws[i - 1].width), 1, `${text} letters touch or overlap`);
    }
    const end = draws.at(-1).x + draws.at(-1).width;
    assert.ok(Math.abs(draws[0].x - (width - end)) <= 1, `${text} is not centered`);
  }
});
