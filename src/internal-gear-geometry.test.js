import test from 'node:test';
import assert from 'node:assert/strict';
import polygonClipping from 'polygon-clipping';
import {
  getInternalGearInnerRing,
  getInternalGearMaximumModule,
  getInternalGearMaximumTeeth,
  getInternalGearMinimumOuterDiameter,
  getInternalGearOuterRing,
  getInternalGearRadii,
  pointInInternalGear,
} from './internal-gear-geometry.js';

const gear = {
  type: 'internalGear',
  x: 60,
  y: 60,
  module: 1,
  teeth: 50,
  outerDiameter: 68,
};

test('default internal gear keeps ten millimeters from tooth tip to outer edge', () => {
  const radii = getInternalGearRadii(gear);
  assert.equal(radii.pitchRadius, 25);
  assert.equal(radii.tipRadius, 24);
  assert.equal(radii.rootRadius, 26.25);
  assert.equal(radii.outerRadius - radii.tipRadius, 10);
});

test('minimum outer diameter leaves material outside the root circle', () => {
  const minimum = getInternalGearMinimumOuterDiameter(gear);
  assert.equal(minimum, 54.5);
  assert.ok(minimum > getInternalGearRadii(gear).rootRadius * 2);
});

test('inner tooth ring is finite and joins at the period boundary', () => {
  const ring = getInternalGearInnerRing(gear);
  assert.ok(ring.length > gear.teeth * 10);
  assert.ok(ring.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)));
  const radii = ring.map(([x, y]) => Math.hypot(x - gear.x, y - gear.y));
  assert.ok(Math.min(...radii) >= 23.999999);
  assert.ok(Math.max(...radii) <= 26.250001);
  const closingEdge = Math.hypot(ring[0][0] - ring.at(-1)[0], ring[0][1] - ring.at(-1)[1]);
  assert.ok(closingEdge > 0.0001);
  assert.ok(closingEdge < 1);
});

test('outer circle minus toothed center creates one polygon with one hole', () => {
  const body = polygonClipping.difference(
    [[getInternalGearOuterRing(gear)]],
    [[getInternalGearInnerRing(gear)]],
  );
  assert.equal(body.length, 1);
  assert.equal(body[0].length, 2);
});

test('internal gear point test distinguishes hole, teeth, and outside', () => {
  const toothCenterAngle = Math.PI / gear.teeth;
  assert.equal(pointInInternalGear(gear, 60, 60), false);
  assert.equal(
    pointInInternalGear(
      gear,
      60 + Math.cos(toothCenterAngle) * 24,
      60 + Math.sin(toothCenterAngle) * 24,
    ),
    true,
  );
  assert.equal(pointInInternalGear(gear, 93, 60), true);
  assert.equal(pointInInternalGear(gear, 95, 60), false);
});

test('slider limits retain only modules and tooth counts that fit the outer diameter', () => {
  assert.equal(getInternalGearMaximumModule(gear, 68), 1);
  assert.equal(getInternalGearMaximumTeeth(gear, 68), 63);
});

test('valid minimum and larger gears remain one closed ring', () => {
  const cases = [
    { module: 0.5, teeth: 34, outerDiameter: 25 },
    { module: 1, teeth: 50, outerDiameter: 68 },
    { module: 1.5, teeth: 40, outerDiameter: 70 },
    { module: 2, teeth: 50, outerDiameter: 110 },
  ];
  cases.forEach((parameters) => {
    const shape = { ...gear, ...parameters };
    const body = polygonClipping.difference(
      [[getInternalGearOuterRing(shape)]],
      [[getInternalGearInnerRing(shape)]],
    );
    assert.equal(body.length, 1);
    assert.equal(body[0].length, 2);
  });
});
