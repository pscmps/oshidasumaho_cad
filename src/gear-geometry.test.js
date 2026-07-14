import test from 'node:test';
import assert from 'node:assert/strict';
import polygonClipping from 'polygon-clipping';
import {
  getGearBoreRing,
  getGearBoreMax,
  getGearOutlineRing,
  getGearRadii,
  pointInGear,
  pointInGearOuter,
} from './gear-geometry.js';

const gear = { type: 'gear', x: 60, y: 60, module: 1, teeth: 24, bore: 6 };

test('default spur gear uses standard pitch and outside diameters', () => {
  const radii = getGearRadii(gear);
  assert.equal(radii.pitchRadius, 12);
  assert.equal(radii.outerRadius, 13);
  assert.equal(radii.boreRadius, 3);
});

test('involute outline produces a finite closed-period ring', () => {
  const ring = getGearOutlineRing(gear);
  assert.ok(ring.length > gear.teeth * 10);
  assert.ok(ring.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)));
  const radii = ring.map(([x, y]) => Math.hypot(x - gear.x, y - gear.y));
  assert.ok(Math.max(...radii) <= 13.000001);
  assert.ok(Math.min(...radii) >= 10.749999);
});

test('gear body excludes its center bore', () => {
  assert.equal(pointInGearOuter(gear, 60, 60), true);
  assert.equal(pointInGear(gear, 60, 60), false);
  assert.equal(pointInGear(gear, 70, 60), true);
  assert.equal(pointInGear(gear, 74, 60), false);
});

test('maximum bore keeps material inside the root circle', () => {
  assert.ok(getGearBoreMax(gear) < getGearRadii(gear).rootRadius * 2);
  assert.ok(getGearBoreMax(gear) > gear.bore);
});

test('default gear and bore form one valid polygon with one hole', () => {
  const body = polygonClipping.difference(
    [[getGearOutlineRing(gear)]],
    [[getGearBoreRing(gear)]],
  );
  assert.equal(body.length, 1);
  assert.equal(body[0].length, 2);
});
