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
