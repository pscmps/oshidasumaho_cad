import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLockedDocumentFromBounds,
  diagnoseProjectionConsistency,
} from './projection-consistency.js';

const consistentBounds = {
  top: { minX: 10, maxX: 55, minY: 20, maxY: 50 },
  front: { minX: 10, maxX: 55, minY: 30, maxY: 60 },
  right: { minX: 20, maxX: 50, minY: 30, maxY: 60 },
};

test('matching shared ranges are valid', () => {
  assert.deepEqual(diagnoseProjectionConsistency(consistentBounds), {
    valid: true,
    missingFaces: [],
    mismatches: [],
  });
});

test('figure-eight depth versus 70 mm right face reports depth mismatch', () => {
  const diagnostic = diagnoseProjectionConsistency({
    ...consistentBounds,
    right: { ...consistentBounds.right, minX: 0, maxX: 70 },
  });
  assert.equal(diagnostic.valid, false);
  assert.equal(diagnostic.mismatches[0].dimension, 'depth');
  assert.deepEqual(diagnostic.mismatches[0].firstRange, { min: 20, max: 50 });
  assert.deepEqual(diagnostic.mismatches[0].secondRange, { min: 0, max: 70 });
});

test('automatic locking stores each face bounds', () => {
  const locked = createLockedDocumentFromBounds({ shapes: [] }, consistentBounds);
  assert.equal(locked.areaLocks.top, true);
  assert.deepEqual(locked.areaLockConstraints.right, {
    ...consistentBounds.right,
    constrainedX: true,
    constrainedY: true,
  });
});
