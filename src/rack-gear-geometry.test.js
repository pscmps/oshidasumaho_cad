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
  assert.equal(dimensions.profileWidth, 62.8);
  assert.equal(dimensions.rotation, 0);
  assert.equal(dimensions.boundsWidth, 62.8);
  assert.equal(dimensions.boundsHeight, 10);
  assert.equal(dimensions.toothDepth, 2.25);
  assert.equal(roundToModelPrecision(dimensions.width), 62.8);
});

test('rack outline starts and ends at the tooth root', () => {
  const dimensions = getRackGearDimensions(rack);
  const ring = getRackGearOutlineRing(rack);
  assert.deepEqual(ring[0], [rack.x, rack.y + dimensions.toothDepth]);
  assert.ok(ring.some(([x, y]) => x === rack.x + dimensions.width && y === rack.y + dimensions.toothDepth));
  assert.ok(ring.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)));
  assert.equal(Math.max(...ring.map(([x]) => x)) - Math.min(...ring.map(([x]) => x)), 62.8);
});

test('extra rack width extends only the terminal tooth-root land', () => {
  const extended = { ...rack, width: 64.3 };
  const dimensions = getRackGearDimensions(extended);
  const ring = getRackGearOutlineRing(extended);

  assert.equal(dimensions.profileWidth, 62.8);
  assert.equal(dimensions.width, 64.3);
  assert.ok(ring.some(([x, y]) => x === 82.8 && y === rack.y + dimensions.toothDepth));
  assert.ok(ring.some(([x, y]) => x === 84.3 && y === rack.y + dimensions.toothDepth));
  assert.equal(Math.max(...ring.map(([x]) => x)), 84.3);
});

test('rack rotation keeps x and y as the rotated bounding-box origin', () => {
  const rotated = { ...rack, width: 64.3, rotation: 90 };
  const dimensions = getRackGearDimensions(rotated);
  const ring = getRackGearOutlineRing(rotated);

  assert.equal(dimensions.boundsWidth, 10);
  assert.equal(dimensions.boundsHeight, 64.3);
  assert.equal(Math.min(...ring.map(([x]) => x)), rotated.x);
  assert.equal(Math.max(...ring.map(([x]) => x)), rotated.x + 10);
  assert.equal(Math.min(...ring.map(([, y]) => y)), rotated.y);
  assert.equal(Math.max(...ring.map(([, y]) => y)), rotated.y + 64.3);
  assert.equal(pointInRackGear(rotated, rotated.x + 9.5, rotated.y + dimensions.pitch / 2), true);
});

test('rack outline is accepted as one polygon', () => {
  const result = polygonClipping.union([[getRackGearOutlineRing(rack)]]);
  assert.equal(result.length, 1);
  assert.equal(result[0].length, 1);
});

test('extended rack remains one polygon in all four rotations', () => {
  [0, 90, 180, 270].forEach((rotation) => {
    const result = polygonClipping.union([[
      getRackGearOutlineRing({ ...rack, width: 64.3, rotation }),
    ]]);
    assert.equal(result.length, 1);
    assert.equal(result[0].length, 1);
  });
});

test('rack point test follows teeth and body', () => {
  const dimensions = getRackGearDimensions(rack);
  assert.equal(pointInRackGear(rack, rack.x + dimensions.pitch / 2, rack.y + 0.5), true);
  assert.equal(pointInRackGear(rack, rack.x, rack.y), false);
  assert.equal(pointInRackGear(rack, rack.x + 5, rack.y + 8), true);
  assert.equal(pointInRackGear(rack, rack.x + 5, rack.y + 11), false);
});
