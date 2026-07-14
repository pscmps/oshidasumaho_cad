import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ceilToModelPrecision,
  createDiscreteSliderScale,
  floorToModelPrecision,
  normalizeModelPrecision,
  roundToModelPrecision,
} from './numeric-precision.js';

test('model values are limited to one decimal place', () => {
  assert.equal(roundToModelPrecision(62.831853), 62.8);
  assert.equal(floorToModelPrecision(54.2999), 54.2);
  assert.equal(ceilToModelPrecision(54.2001), 54.3);
});

test('shape dimensions and lock constraints use the same precision', () => {
  const document = normalizeModelPrecision({
    extrude: 12.345,
    areaLockConstraints: {
      top: { minX: 10.004, maxX: 72.835, minY: 4.444, maxY: 20.055 },
    },
    shapes: [
      { type: 'rect', x: 10.004, y: 4.444, w: 62.831853, h: 15.611 },
      { type: 'internalGear', x: 60.005, y: 59.994, module: 1, teeth: 50, outerDiameter: 68.049 },
    ],
  });
  assert.equal(document.extrude, 12.3);
  assert.deepEqual(document.areaLockConstraints.top, {
    minX: 10,
    maxX: 72.8,
    minY: 4.4,
    maxY: 20.1,
  });
  assert.equal(document.shapes[0].w, 62.8);
  assert.equal(document.shapes[1].outerDiameter, 68);
});

test('one-unit sliders retain a fractional maximum as the final stop', () => {
  const scale = createDiscreteSliderScale(1, 103.4, 1);

  assert.equal(scale.maxPosition, 103);
  assert.equal(scale.valueAt(102), 103);
  assert.equal(scale.valueAt(103), 103.4);
  assert.equal(scale.positionFor(103.4), 103);
});

test('aligned slider ranges do not add a duplicate terminal stop', () => {
  const scale = createDiscreteSliderScale(0.5, 5, 0.5);

  assert.equal(scale.maxPosition, 9);
  assert.equal(scale.valueAt(9), 5);
  assert.equal(scale.positionFor(5), 9);
});
