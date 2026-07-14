import test from 'node:test';
import assert from 'node:assert/strict';
import polygonClipping from 'polygon-clipping';
import {
  getRackGearDimensions,
  getRackGearOutlineRing,
  pointInRackGear,
} from './rack-gear-geometry.js';
import { roundToModelPrecision } from './numeric-precision.js';

const rack = { type: 'rack', x: 20, y: 30, module: 1, teeth: 20, height: 10 };

test('default rack uses integer tooth count and circular-pitch width', () => {
  const dimensions = getRackGearDimensions(rack);
  assert.equal(dimensions.teeth, 20);
  assert.equal(dimensions.height, 10);
  assert.ok(Math.abs(dimensions.nominalWidth - Math.PI * 20) < 0.000001);
  assert.equal(dimensions.width, 62.8);
  assert.equal(dimensions.toothDepth, 2.25);
  assert.equal(roundToModelPrecision(dimensions.width), 62.8);
});

test('rack outline starts and ends at the tooth root', () => {
  const dimensions = getRackGearDimensions(rack);
  const ring = getRackGearOutlineRing(rack);
  assert.deepEqual(ring[0], [rack.x, rack.y + dimensions.toothDepth]);
  assert.deepEqual(ring[ring.length - 3], [rack.x + dimensions.width, rack.y + dimensions.toothDepth]);
  assert.ok(ring.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)));
  assert.equal(Math.max(...ring.map(([x]) => x)) - Math.min(...ring.map(([x]) => x)), 62.8);
});

test('rack outline is accepted as one polygon', () => {
  const result = polygonClipping.union([[getRackGearOutlineRing(rack)]]);
  assert.equal(result.length, 1);
  assert.equal(result[0].length, 1);
});

test('rack point test follows teeth and body', () => {
  const dimensions = getRackGearDimensions(rack);
  assert.equal(pointInRackGear(rack, rack.x + dimensions.pitch / 2, rack.y + 0.5), true);
  assert.equal(pointInRackGear(rack, rack.x, rack.y), false);
  assert.equal(pointInRackGear(rack, rack.x + 5, rack.y + 8), true);
  assert.equal(pointInRackGear(rack, rack.x + 5, rack.y + 11), false);
});
