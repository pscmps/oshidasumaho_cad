export const PROJECTION_RANGE_PAIRS = [
  {
    dimension: 'width',
    first: { face: 'top', axis: 'x' },
    second: { face: 'front', axis: 'x' },
  },
  {
    dimension: 'depth',
    first: { face: 'top', axis: 'y' },
    second: { face: 'right', axis: 'x' },
  },
  {
    dimension: 'height',
    first: { face: 'front', axis: 'y' },
    second: { face: 'right', axis: 'y' },
  },
];

function getAxisRange(bounds, axis) {
  if (!bounds) {
    return null;
  }
  return axis === 'x'
    ? { min: bounds.minX, max: bounds.maxX }
    : { min: bounds.minY, max: bounds.maxY };
}

export function projectionRangesMatch(actual, expected, tolerance = 0.001) {
  return Math.abs(actual.min - expected.min) <= tolerance
    && Math.abs(actual.max - expected.max) <= tolerance;
}

function getFaceAxisReadiness(
  pair,
  target,
  counterpart,
  faceBounds,
  areaLocks,
  areaLockConstraints,
  tolerance,
) {
  const baseResult = {
    dimension: pair.dimension,
    counterpartFace: counterpart.face,
  };
  if (areaLocks?.[target.face]) {
    return {
      ...baseResult,
      status: 'hidden',
      reason: 'target-locked',
      actualRange: null,
      expectedRange: null,
    };
  }

  const counterpartConstraint = areaLocks?.[counterpart.face]
    ? areaLockConstraints?.[counterpart.face]
    : null;
  if (!counterpartConstraint) {
    return {
      ...baseResult,
      status: 'hidden',
      reason: 'no-locked-counterpart',
      actualRange: null,
      expectedRange: null,
    };
  }

  const targetBounds = faceBounds?.[target.face];
  if (!targetBounds) {
    return {
      ...baseResult,
      status: 'fail',
      reason: 'missing-shape',
      actualRange: null,
      expectedRange: getAxisRange(counterpartConstraint, counterpart.axis),
    };
  }

  const actualRange = getAxisRange(targetBounds, target.axis);
  const expectedRange = getAxisRange(counterpartConstraint, counterpart.axis);
  return {
    ...baseResult,
    status: projectionRangesMatch(actualRange, expectedRange, tolerance) ? 'pass' : 'fail',
    reason: 'locked-range-edges',
    actualRange,
    expectedRange,
  };
}

export function getProjectionReadiness(
  faceBounds,
  areaLocks = {},
  areaLockConstraints = {},
  tolerance = 0.001,
) {
  const readiness = { top: {}, front: {}, right: {} };

  PROJECTION_RANGE_PAIRS.forEach((pair) => {
    readiness[pair.first.face][pair.first.axis] = getFaceAxisReadiness(
      pair,
      pair.first,
      pair.second,
      faceBounds,
      areaLocks,
      areaLockConstraints,
      tolerance,
    );
    readiness[pair.second.face][pair.second.axis] = getFaceAxisReadiness(
      pair,
      pair.second,
      pair.first,
      faceBounds,
      areaLocks,
      areaLockConstraints,
      tolerance,
    );
  });

  return readiness;
}

export function diagnoseProjectionConsistency(faceBounds, tolerance = 0.001) {
  const missingFaces = ['top', 'front', 'right'].filter((face) => !faceBounds?.[face]);
  const mismatches = PROJECTION_RANGE_PAIRS.flatMap((pair) => {
    const firstRange = getAxisRange(faceBounds?.[pair.first.face], pair.first.axis);
    const secondRange = getAxisRange(faceBounds?.[pair.second.face], pair.second.axis);
    if (!firstRange || !secondRange) {
      return [];
    }
    if (
      Math.abs(firstRange.min - secondRange.min) <= tolerance &&
      Math.abs(firstRange.max - secondRange.max) <= tolerance
    ) {
      return [];
    }
    return [{ ...pair, firstRange, secondRange }];
  });

  return {
    valid: missingFaces.length === 0 && mismatches.length === 0,
    missingFaces,
    mismatches,
  };
}

export function createLockedDocumentFromBounds(document, faceBounds) {
  return {
    ...document,
    areaLocks: {
      top: true,
      front: true,
      right: true,
    },
    areaLockConstraints: Object.fromEntries(
      ['top', 'front', 'right'].map((face) => [
        face,
        {
          ...faceBounds[face],
          constrainedX: true,
          constrainedY: true,
        },
      ]),
    ),
  };
}
