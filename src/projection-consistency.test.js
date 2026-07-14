import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLockedDocumentFromBounds,
  diagnoseProjectionConsistency,
  getProjectionReadiness,
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

test('top lock marks exact front width and right depth as ready', () => {
  const readiness = getProjectionReadiness(
    consistentBounds,
    { top: true, front: false, right: false },
    { top: { ...consistentBounds.top, constrainedX: true, constrainedY: true } },
  );

  assert.equal(readiness.front.x.status, 'pass');
  assert.equal(readiness.front.x.dimension, 'width');
  assert.equal(readiness.right.x.status, 'pass');
  assert.equal(readiness.right.x.dimension, 'depth');
});

test('contained range stays failed until both locked edges match', () => {
  const readiness = getProjectionReadiness(
    {
      ...consistentBounds,
      front: { ...consistentBounds.front, minX: 15, maxX: 50 },
    },
    { top: true, front: false, right: false },
    { top: { ...consistentBounds.top, constrainedX: true, constrainedY: true } },
  );

  assert.equal(readiness.front.x.status, 'fail');
  assert.deepEqual(readiness.front.x.expectedRange, { min: 10, max: 55 });
});

test('range overflow also marks the corresponding axis as failed', () => {
  const readiness = getProjectionReadiness(
    {
      ...consistentBounds,
      front: { ...consistentBounds.front, minX: 5, maxX: 60 },
    },
    { top: true, front: false, right: false },
    { top: { ...consistentBounds.top, constrainedX: true, constrainedY: true } },
  );

  assert.equal(readiness.front.x.status, 'fail');
});

test('unconstrained directions stay hidden while a constrained missing target fails', () => {
  const readiness = getProjectionReadiness(
    { top: consistentBounds.top, front: consistentBounds.front, right: null },
    { top: true, front: false, right: false },
    { top: { ...consistentBounds.top, constrainedX: true, constrainedY: true } },
  );

  assert.equal(readiness.front.y.status, 'hidden');
  assert.equal(readiness.right.x.status, 'fail');
  assert.equal(readiness.right.y.status, 'hidden');
});

test('all indicators stay hidden before the first lock', () => {
  const readiness = getProjectionReadiness(consistentBounds);
  assert.equal(readiness.top.x.status, 'hidden');
  assert.equal(readiness.front.x.status, 'hidden');
  assert.equal(readiness.right.y.status, 'hidden');
});

test('starting from front or right activates the matching axes', () => {
  const frontFirst = getProjectionReadiness(
    consistentBounds,
    { top: false, front: true, right: false },
    { front: { ...consistentBounds.front, constrainedX: true, constrainedY: true } },
  );
  assert.equal(frontFirst.top.x.status, 'pass');
  assert.equal(frontFirst.right.y.status, 'pass');

  const rightFirst = getProjectionReadiness(
    consistentBounds,
    { top: false, front: false, right: true },
    { right: { ...consistentBounds.right, constrainedX: true, constrainedY: true } },
  );
  assert.equal(rightFirst.top.y.status, 'pass');
  assert.equal(rightFirst.front.y.status, 'pass');
});

test('a locked face keeps using its frozen range after its shape shrinks', () => {
  const readiness = getProjectionReadiness(
    {
      ...consistentBounds,
      top: { ...consistentBounds.top, minY: 25, maxY: 45 },
    },
    { top: true, front: false, right: false },
    { top: { ...consistentBounds.top, constrainedX: true, constrainedY: true } },
  );

  assert.equal(readiness.right.x.status, 'pass');
  assert.deepEqual(readiness.right.x.expectedRange, { min: 20, max: 50 });
});

test('indicators disappear from a face after it is locked', () => {
  const readiness = getProjectionReadiness(
    consistentBounds,
    { top: true, front: true, right: true },
    {
      top: { ...consistentBounds.top, constrainedX: true, constrainedY: true },
      front: { ...consistentBounds.front, constrainedX: true, constrainedY: true },
      right: { ...consistentBounds.right, constrainedX: true, constrainedY: true },
    },
  );

  assert.equal(readiness.top.x.status, 'hidden');
  assert.equal(readiness.front.y.status, 'hidden');
  assert.equal(readiness.right.x.status, 'hidden');
});
