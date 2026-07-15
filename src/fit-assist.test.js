import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractAxisFitTargets,
  findFitValue,
  getShapeBounds2D,
  isFitBypassActive,
} from './fit-assist.js';

const steppedPolygon = [[[
  [10, 10], [50, 10], [50, 30], [35, 30],
  [35, 50], [10, 50],
]]];

test('fit targets contain visible straight steps, outer bounds, and one overall center', () => {
  assert.deepEqual(extractAxisFitTargets(steppedPolygon, 'x'), {
    edges: [10, 35, 50],
    center: 30,
  });
  assert.deepEqual(extractAxisFitTargets(steppedPolygon, 'y'), {
    edges: [10, 30, 50],
    center: 30,
  });
});

test('slanted detail does not create extra step targets', () => {
  const polygon = [[[[10, 10], [40, 20], [30, 50], [10, 10]]]];
  assert.deepEqual(extractAxisFitTargets(polygon, 'x'), { edges: [10, 40], center: 25 });
});

test('position fit aligns a rectangle edge or overall center within the capture distance', () => {
  const shape = { type: 'rect', x: 10, y: 5, w: 20, h: 10 };
  const targetsByAxis = { x: { edges: [12.4, 32.4], center: 22.4 }, y: null };
  const result = findFitValue({
    shape,
    field: 'x',
    rawValue: 12,
    targetsByAxis,
    evaluateShape: (x) => ({ ...shape, x }),
  });
  assert.equal(result.value, 12.4);
  assert.equal(result.kind, 'min');
});

test('size fit aligns the changed rectangle edge but not the center', () => {
  const shape = { type: 'rect', x: 10, y: 5, w: 20, h: 10 };
  const result = findFitValue({
    shape,
    field: 'w',
    rawValue: 22,
    targetsByAxis: { x: { edges: [32.4], center: 21 }, y: null },
    evaluateShape: (w) => ({ ...shape, w }),
  });
  assert.equal(result.value, 22.4);
  assert.equal(result.kind, 'max');
});

test('gear standard parameters are not eligible for fitting', () => {
  const shape = { type: 'gear', x: 20, y: 20, module: 1, teeth: 24 };
  assert.equal(findFitValue({
    shape,
    field: 'module',
    rawValue: 1,
    targetsByAxis: { x: { edges: [33], center: 20 }, y: null },
    evaluateShape: (module) => ({ ...shape, module }),
  }), null);
});

test('fit bypass permits immediate adjustment and rearms after two millimeters', () => {
  assert.equal(isFitBypassActive(12.9, 12.4), true);
  assert.equal(isFitBypassActive(14.3, 12.4), true);
  assert.equal(isFitBypassActive(14.4, 12.4), false);
});

test('rack rotation maps width fitting to the rotated axis', () => {
  const shape = {
    type: 'rack', x: 10, y: 10, module: 1, teeth: 20, width: 62.8, height: 10, rotation: 90,
  };
  const bounds = getShapeBounds2D(shape);
  const result = findFitValue({
    shape,
    field: 'width',
    rawValue: 63,
    targetsByAxis: { x: null, y: { edges: [bounds.minY + 63.4], center: 60 } },
    evaluateShape: (width) => ({ ...shape, width }),
  });
  assert.equal(result.value, 63.4);
  assert.equal(result.axis, 'y');
});
