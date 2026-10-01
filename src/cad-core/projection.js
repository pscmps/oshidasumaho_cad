import earcut from 'earcut';
import polygonClipping from 'polygon-clipping';
import { createLockedDocumentFromBounds, diagnoseProjectionConsistency, projectionRangesMatch } from '../projection-consistency.js';
import { hasNativeGeometry } from './mesh.js';
import {
  GEAR_MODULE_MAX,
  GEAR_MODULE_MIN,
  GEAR_TEETH_MAX,
  GEAR_TEETH_MIN,
  getGearBoreMax,
  getGearBoreRing,
  getGearBoreSignedDistance,
  getGearOuterSignedDistance,
  getGearOutlineRing,
  getGearRadii,
  pointInGearOuter,
} from '../gear-geometry.js';
import {
  RACK_HEIGHT_MAX,
  RACK_TEETH_MAX,
  RACK_TEETH_MIN,
  getRackGearDimensions,
  getRackGearOutlineRing,
  getRackGearSignedDistance,
  normalizeRackRotation,
  pointInRackGear,
} from '../rack-gear-geometry.js';
import {
  INTERNAL_GEAR_TEETH_MAX,
  INTERNAL_GEAR_TEETH_MIN,
  getInternalGearInnerRing,
  getInternalGearInnerSignedDistance,
  getInternalGearMaximumModule,
  getInternalGearMaximumTeeth,
  getInternalGearMinimumOuterDiameter,
  getInternalGearOuterRing,
  getInternalGearOuterSignedDistance,
  getInternalGearRadii,
  pointInInternalGear,
} from '../internal-gear-geometry.js';
import {
  ceilToModelPrecision,
  createDiscreteSliderScale,
  floorToModelPrecision,
  normalizeModelPrecision,
  normalizeShapePrecision,
  roundToModelPrecision,
} from '../numeric-precision.js';
import {
  extractAxisFitTargets,
  findFitValue,
  getShapeBounds2D,
  includeShapeFitTargets,
  isFitBypassActive,
} from '../fit-assist.js';

const SOLID_PREVIEW_STEPS = 18;
const CIRCLE_MESH_SEGMENTS = 64;
const STL_VOXEL_CELL_SIZE = 0.5;
const STL_VOXEL_MAX_AXIS_STEPS = 180;
const STL_VOXEL_MAX_CELLS = 12_000_000;
const STL_RESOLUTION_MAX = 20;
const SECTION_SAMPLE_EPSILON = 0.001;
const FACE_ORDER = ['top', 'front', 'right'];
const FACE_LABELS = {
  top: '上面',
  front: '正面',
  right: '右側面',
};
const FACE_AXES = {
  top: { x: 'width', y: 'depth' },
  front: { x: 'width', y: 'height' },
  right: { x: 'depth', y: 'height' },
};
const DIMENSION_LABELS = {
  width: '幅',
  depth: '奥行',
  height: '高さ',
};
const DEFAULT_AREA_LOCKS = {
  top: false,
  front: false,
  right: false,
};
const DEFAULT_AREA_LOCK_CONSTRAINTS = {
  top: null,
  front: null,
  right: null,
};

function normalizeFace(face) {
  if (face === 'left') {
    return 'front';
  }
  return FACE_ORDER.includes(face) ? face : 'top';
}

function clampRangeValue(value) {
  return roundToModelPrecision(Math.min(120, Math.max(0, value)));
}

function getFaceBounds(shapes, face) {
  const faceShapes = shapes.filter((shape) => normalizeFace(shape.face) === face);
  return getBooleanPolygonBounds(getFaceBooleanPolygons(faceShapes));
}

function getAllFaceBounds(shapes) {
  return Object.fromEntries(FACE_ORDER.map((face) => [face, getFaceBounds(shapes, face)]));
}

function getFitTargetsForFace(document, targetFace) {
  const normalizedTargetFace = normalizeFace(targetFace);
  return Object.fromEntries(['x', 'y'].map((targetAxis) => {
    const dimension = FACE_AXES[normalizedTargetFace][targetAxis];
    const sourceFace = FACE_ORDER.find((face) => (
      face !== normalizedTargetFace
      && document.areaLocks?.[face]
      && Object.values(FACE_AXES[face]).includes(dimension)
    ));
    if (!sourceFace) {
      return [targetAxis, null];
    }
    const sourceAxis = Object.entries(FACE_AXES[sourceFace])
      .find(([, sourceDimension]) => sourceDimension === dimension)?.[0];
    const sourceShapes = document.shapes.filter((shape) => normalizeFace(shape.face) === sourceFace);
    const polygons = getFaceBooleanPolygons(sourceShapes);
    const outlineTargets = extractAxisFitTargets(polygons, sourceAxis);
    return [targetAxis, includeShapeFitTargets(outlineTargets, sourceShapes, sourceAxis)];
  }));
}

function getFaceConstraint(face, faceBounds) {
  const sourceBoundsByFace = Object.fromEntries(
    FACE_ORDER.map((sourceFace) => [
      sourceFace,
      sourceFace === face ? null : faceBounds[sourceFace],
    ]),
  );

  return getProjectedConstraint(face, sourceBoundsByFace);
}

function createEmptyConstraint() {
  return {
    minX: 0,
    maxX: 120,
    minY: 0,
    maxY: 120,
    constrainedX: false,
    constrainedY: false,
  };
}

function getProjectedConstraint(targetFace, sourceBoundsByFace) {
  const constraint = createEmptyConstraint();

  FACE_ORDER.forEach((sourceFace) => {
    const sourceBounds = sourceBoundsByFace[sourceFace];
    if (!sourceBounds) {
      return;
    }

    applyProjectedAxisConstraint(constraint, targetFace, sourceFace, 'x', sourceBounds);
    applyProjectedAxisConstraint(constraint, targetFace, sourceFace, 'y', sourceBounds);
  });

  return constraint;
}

function applyProjectedAxisConstraint(constraint, targetFace, sourceFace, sourceAxis, sourceBounds) {
  const sourceDimension = FACE_AXES[sourceFace][sourceAxis];
  const targetAxis = Object.entries(FACE_AXES[targetFace])
    .find(([, dimension]) => dimension === sourceDimension)?.[0];
  if (!targetAxis) {
    return;
  }

  const min = sourceAxis === 'x' ? sourceBounds.minX : sourceBounds.minY;
  const max = sourceAxis === 'x' ? sourceBounds.maxX : sourceBounds.maxY;
  if (targetAxis === 'x') {
    constraint.minX = Math.max(constraint.minX, min);
    constraint.maxX = Math.min(constraint.maxX, max);
    constraint.constrainedX = true;
  } else {
    constraint.minY = Math.max(constraint.minY, min);
    constraint.maxY = Math.min(constraint.maxY, max);
    constraint.constrainedY = true;
  }
}

function getLockConstraintForBounds(bounds) {
  if (!bounds) {
    return null;
  }

  return {
    ...bounds,
    constrainedX: true,
    constrainedY: true,
  };
}

function normalizeConstraint(constraint) {
  if (!constraint) {
    return null;
  }

  return {
    minX: clampRangeValue(Number(constraint.minX) || 0),
    maxX: clampRangeValue(Number(constraint.maxX) || 120),
    minY: clampRangeValue(Number(constraint.minY) || 0),
    maxY: clampRangeValue(Number(constraint.maxY) || 120),
    constrainedX: Boolean(constraint.constrainedX),
    constrainedY: Boolean(constraint.constrainedY),
  };
}

function getDocumentFaceConstraint(document, face, faceBounds = getAllFaceBounds(document.shapes)) {
  const normalizedFace = normalizeFace(face);
  const sourceBoundsByFace = Object.fromEntries(
    FACE_ORDER.map((sourceFace) => {
      const savedConstraint = normalizeConstraint(document.areaLockConstraints?.[sourceFace]);
      if (document.areaLocks?.[sourceFace] && savedConstraint) {
        return [sourceFace, savedConstraint];
      }
      return [sourceFace, sourceFace === normalizedFace ? null : faceBounds[sourceFace]];
    }),
  );

  return getProjectedConstraint(normalizedFace, sourceBoundsByFace);
}

function getLockedFaceConstraint(document, face) {
  const normalizedFace = normalizeFace(face);
  const sourceBoundsByFace = Object.fromEntries(
    FACE_ORDER.map((sourceFace) => [
      sourceFace,
      document.areaLocks?.[sourceFace]
        ? normalizeConstraint(document.areaLockConstraints?.[sourceFace])
        : null,
    ]),
  );

  return getProjectedConstraint(normalizedFace, sourceBoundsByFace);
}

function getAllDisplayConstraints(document, faceBounds = getAllFaceBounds(document.shapes)) {
  return Object.fromEntries(
    FACE_ORDER.map((face) => [face, getDocumentFaceConstraint(document, face, faceBounds)]),
  );
}

function getAllLockedConstraints(document) {
  return Object.fromEntries(
    FACE_ORDER.map((face) => [face, getLockedFaceConstraint(document, face)]),
  );
}

function hasAreaConstraint(constraint) {
  return (
    (constraint.constrainedX && constraint.maxX > constraint.minX) ||
    (constraint.constrainedY && constraint.maxY > constraint.minY)
  );
}

function areBoundsWithinConstraint(bounds, constraint) {
  if (!bounds || !hasAreaConstraint(constraint)) {
    return true;
  }

  return (
    bounds.minX >= constraint.minX - 0.001 &&
    bounds.maxX <= constraint.maxX + 0.001 &&
    bounds.minY >= constraint.minY - 0.001 &&
    bounds.maxY <= constraint.maxY + 0.001
  );
}

function areLockedFaceBoundsValid(document) {
  const faceBounds = getAllFaceBounds(document.shapes);
  const lockedConstraints = getAllLockedConstraints(document);
  return FACE_ORDER.every((face) =>
    areBoundsWithinConstraint(faceBounds[face], lockedConstraints[face]),
  );
}

function canLockFace(document, face, faceBounds = getAllFaceBounds(document.shapes)) {
  return getAreaLockDiagnostic(document, face, faceBounds).canLock;
}

function getConstraintSourceFaces(document, targetFace, targetAxis) {
  const dimension = FACE_AXES[targetFace][targetAxis];
  return FACE_ORDER.filter((sourceFace) => {
    if (!document.areaLocks?.[sourceFace] || !document.areaLockConstraints?.[sourceFace]) {
      return false;
    }
    return Object.values(FACE_AXES[sourceFace]).includes(dimension);
  });
}

function getAreaLockDiagnostic(document, face, faceBounds = getAllFaceBounds(document.shapes)) {
  const normalizedFace = normalizeFace(face);
  const sourceConstraint = getLockConstraintForBounds(faceBounds[normalizedFace]);
  if (!sourceConstraint) {
    return {
      canLock: false,
      face: normalizedFace,
      reason: 'missing-shape',
      violations: [],
    };
  }

  const existingConstraint = getLockedFaceConstraint(document, normalizedFace);
  const exactEdgeViolations = ['x', 'y'].flatMap((axis) => {
    const constrained = axis === 'x'
      ? existingConstraint?.constrainedX
      : existingConstraint?.constrainedY;
    if (!constrained) {
      return [];
    }
    const actualMin = axis === 'x' ? sourceConstraint.minX : sourceConstraint.minY;
    const actualMax = axis === 'x' ? sourceConstraint.maxX : sourceConstraint.maxY;
    const expectedMin = axis === 'x' ? existingConstraint.minX : existingConstraint.minY;
    const expectedMax = axis === 'x' ? existingConstraint.maxX : existingConstraint.maxY;
    if (projectionRangesMatch(
      { min: actualMin, max: actualMax },
      { min: expectedMin, max: expectedMax },
    )) {
      return [];
    }
    return [{
      targetFace: normalizedFace,
      axis,
      dimension: FACE_AXES[normalizedFace][axis],
      actualMin,
      actualMax,
      expectedMin,
      expectedMax,
      sourceFaces: getConstraintSourceFaces(document, normalizedFace, axis),
      matchMode: 'exact-edges',
    }];
  });

  const proposedDocument = {
    ...document,
    areaLocks: {
      ...DEFAULT_AREA_LOCKS,
      ...document.areaLocks,
      [normalizedFace]: true,
    },
    areaLockConstraints: {
      ...DEFAULT_AREA_LOCK_CONSTRAINTS,
      ...document.areaLockConstraints,
      [normalizedFace]: sourceConstraint,
    },
  };
  const lockedConstraints = getAllLockedConstraints(proposedDocument);
  const containmentViolations = FACE_ORDER.flatMap((targetFace) => {
    const bounds = faceBounds[targetFace];
    const constraint = lockedConstraints[targetFace];
    if (!bounds || !hasAreaConstraint(constraint)) {
      return [];
    }

    return ['x', 'y'].flatMap((axis) => {
      const constrained = axis === 'x' ? constraint.constrainedX : constraint.constrainedY;
      if (!constrained) {
        return [];
      }
      const actualMin = axis === 'x' ? bounds.minX : bounds.minY;
      const actualMax = axis === 'x' ? bounds.maxX : bounds.maxY;
      const expectedMin = axis === 'x' ? constraint.minX : constraint.minY;
      const expectedMax = axis === 'x' ? constraint.maxX : constraint.maxY;
      if (actualMin >= expectedMin - 0.001 && actualMax <= expectedMax + 0.001) {
        return [];
      }
      return [{
        targetFace,
        axis,
        dimension: FACE_AXES[targetFace][axis],
        actualMin,
        actualMax,
        expectedMin,
        expectedMax,
        sourceFaces: getConstraintSourceFaces(proposedDocument, targetFace, axis),
      }];
    });
  });
  const violations = [...containmentViolations];
  exactEdgeViolations.forEach((violation) => {
    const duplicate = violations.some((current) =>
      current.targetFace === violation.targetFace && current.axis === violation.axis,
    );
    if (!duplicate) {
      violations.push(violation);
    }
  });

  return {
    canLock: violations.length === 0,
    face: normalizedFace,
    reason: violations.length ? 'range-mismatch' : null,
    violations,
  };
}

function formatRange(min, max) {
  return `${min.toFixed(1)}～${max.toFixed(1)} mm（${(max - min).toFixed(1)} mm）`;
}

function clampValue(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function constrainShapeToConstraint(shape, constraint) {
  if (!constraint) {
    return shape;
  }

  if (shape.type === 'circle') {
    const maxR = Math.max(
      1,
      Math.min(
        60,
        (constraint.maxX - constraint.minX) / 2,
        (constraint.maxY - constraint.minY) / 2,
      ),
    );
    const r = clampValue(shape.r, 1, maxR);
    return {
      ...shape,
      r,
      x: clampValue(shape.x, constraint.minX + r, constraint.maxX - r),
      y: clampValue(shape.y, constraint.minY + r, constraint.maxY - r),
    };
  }

  if (shape.type === 'gear') {
    const teeth = clampValue(Math.round(shape.teeth), GEAR_TEETH_MIN, GEAR_TEETH_MAX);
    const maximumModule = Math.min(
      GEAR_MODULE_MAX,
      (constraint.maxX - constraint.minX) / (teeth + 2),
      (constraint.maxY - constraint.minY) / (teeth + 2),
    );
    const moduleValue = clampValue(shape.module, GEAR_MODULE_MIN, Math.max(GEAR_MODULE_MIN, maximumModule));
    const constrainedGear = { ...shape, teeth, module: moduleValue };
    const { outerRadius } = getGearRadii(constrainedGear);
    return {
      ...constrainedGear,
      bore: clampValue(shape.bore, 0, getGearBoreMax(constrainedGear)),
      x: clampValue(shape.x, constraint.minX + outerRadius, constraint.maxX - outerRadius),
      y: clampValue(shape.y, constraint.minY + outerRadius, constraint.maxY - outerRadius),
    };
  }
  if (shape.type === 'internalGear') {
    const maximumOuterDiameter = Math.min(
      constraint.maxX - constraint.minX,
      constraint.maxY - constraint.minY,
    );
    let moduleValue = clampValue(shape.module, GEAR_MODULE_MIN, GEAR_MODULE_MAX);
    let teeth = clampValue(
      Math.round(shape.teeth),
      INTERNAL_GEAR_TEETH_MIN,
      getInternalGearMaximumTeeth({ ...shape, module: moduleValue }, maximumOuterDiameter),
    );
    moduleValue = clampValue(
      moduleValue,
      GEAR_MODULE_MIN,
      getInternalGearMaximumModule({ ...shape, teeth }, maximumOuterDiameter),
    );
    teeth = clampValue(
      teeth,
      INTERNAL_GEAR_TEETH_MIN,
      getInternalGearMaximumTeeth({ ...shape, module: moduleValue }, maximumOuterDiameter),
    );
    const internalGear = { ...shape, module: moduleValue, teeth };
    const outerDiameter = clampValue(
      shape.outerDiameter,
      ceilToModelPrecision(getInternalGearMinimumOuterDiameter(internalGear)),
      floorToModelPrecision(maximumOuterDiameter),
    );
    const outerRadius = outerDiameter / 2;
    return {
      ...internalGear,
      outerDiameter,
      x: clampValue(shape.x, constraint.minX + outerRadius, constraint.maxX - outerRadius),
      y: clampValue(shape.y, constraint.minY + outerRadius, constraint.maxY - outerRadius),
    };
  }
  if (shape.type === 'rack') {
    const availableWidth = constraint.maxX - constraint.minX;
    const availableHeight = constraint.maxY - constraint.minY;
    const rotation = normalizeRackRotation(shape.rotation);
    const vertical = rotation === 90 || rotation === 270;
    const availableRackWidth = vertical ? availableHeight : availableWidth;
    const availableRackHeight = vertical ? availableWidth : availableHeight;
    const maximumTeeth = Math.max(
      RACK_TEETH_MIN,
      Math.min(RACK_TEETH_MAX, Math.floor(availableRackWidth / (Math.PI * GEAR_MODULE_MIN))),
    );
    const teeth = clampValue(Math.round(shape.teeth), RACK_TEETH_MIN, maximumTeeth);
    const maximumModule = Math.min(
      GEAR_MODULE_MAX,
      availableRackWidth / (Math.PI * teeth),
      availableRackHeight / 2.25,
    );
    const moduleValue = clampValue(shape.module, GEAR_MODULE_MIN, Math.max(GEAR_MODULE_MIN, maximumModule));
    const provisional = getRackGearDimensions({ ...shape, teeth, module: moduleValue, rotation });
    const height = clampValue(
      roundToModelPrecision(shape.height),
      provisional.minimumHeight,
      Math.max(provisional.minimumHeight, floorToModelPrecision(availableRackHeight)),
    );
    const width = clampValue(
      roundToModelPrecision(shape.width ?? provisional.profileWidth),
      provisional.profileWidth,
      Math.min(provisional.maximumWidth, floorToModelPrecision(availableRackWidth)),
    );
    const constrainedRack = { ...shape, teeth, module: moduleValue, height, width, rotation };
    const dimensions = getRackGearDimensions(constrainedRack);
    return {
      ...constrainedRack,
      x: clampValue(shape.x, constraint.minX, constraint.maxX - dimensions.boundsWidth),
      y: clampValue(shape.y, constraint.minY, constraint.maxY - dimensions.boundsHeight),
    };
  }

  const w = clampValue(shape.w, 1, Math.max(1, constraint.maxX - constraint.minX));
  const h = clampValue(shape.h, 1, Math.max(1, constraint.maxY - constraint.minY));
  return {
    ...shape,
    w,
    h,
    x: clampValue(shape.x, constraint.minX, constraint.maxX - w),
    y: clampValue(shape.y, constraint.minY, constraint.maxY - h),
  };
}

function constrainShape(shape, constraint) {
  return normalizeShapePrecision(
    constrainShapeToConstraint(normalizeShapePrecision(shape), constraint),
  );
}

function constrainEditedShape(document, shape) {
  const face = normalizeFace(shape.face);
  const constraint = getLockedFaceConstraint(document, face);
  if (shape.type === 'gear' || shape.type === 'rack' || shape.type === 'internalGear') {
    return constrainShape(
      shape,
      hasAreaConstraint(constraint)
        ? constraint
        : { minX: 0, maxX: 120, minY: 0, maxY: 120 },
    );
  }
  if (shape.mode === 'cut' || !hasAreaConstraint(constraint)) {
    return normalizeShapePrecision(shape);
  }
  return constrainShape(shape, constraint);
}

function applyAreaLocks(document) {
  const lockedConstraints = getAllLockedConstraints(document);
  return {
    ...document,
    shapes: document.shapes.map((shape) => {
      const face = normalizeFace(shape.face);
      const constraint = lockedConstraints[face];
      if (shape.mode === 'cut' || !hasAreaConstraint(constraint)) {
        return shape;
      }
      return constrainShape(shape, constraint);
    }),
  };
}

function getShapeControlLimits(shape, constraint, locked) {
  const fullConstraint = locked
    ? constraint
    : { minX: 0, maxX: 120, minY: 0, maxY: 120 };

  if (shape.type === 'circle') {
    const rMax = Math.max(
      1,
      Math.min(
        60,
        shape.x - fullConstraint.minX,
        fullConstraint.maxX - shape.x,
        shape.y - fullConstraint.minY,
        fullConstraint.maxY - shape.y,
      ),
    );
    return {
      x: { min: fullConstraint.minX + shape.r, max: fullConstraint.maxX - shape.r },
      y: { min: fullConstraint.minY + shape.r, max: fullConstraint.maxY - shape.r },
      r: { min: 1, max: rMax },
    };
  }

  if (shape.type === 'gear') {
    const { outerRadius } = getGearRadii(shape);
    const availableRadius = Math.max(
      GEAR_MODULE_MIN * (GEAR_TEETH_MIN + 2) / 2,
      Math.min(
        shape.x - fullConstraint.minX,
        fullConstraint.maxX - shape.x,
        shape.y - fullConstraint.minY,
        fullConstraint.maxY - shape.y,
      ),
    );
    return {
      x: { min: fullConstraint.minX + outerRadius, max: fullConstraint.maxX - outerRadius },
      y: { min: fullConstraint.minY + outerRadius, max: fullConstraint.maxY - outerRadius },
      module: {
        min: GEAR_MODULE_MIN,
        max: Math.max(GEAR_MODULE_MIN, Math.min(GEAR_MODULE_MAX, (availableRadius * 2) / (shape.teeth + 2))),
      },
      teeth: {
        min: GEAR_TEETH_MIN,
        max: Math.max(
          GEAR_TEETH_MIN,
          Math.min(GEAR_TEETH_MAX, Math.floor((availableRadius * 2) / shape.module - 2)),
        ),
      },
      bore: { min: 0, max: getGearBoreMax(shape) },
    };
  }
  if (shape.type === 'internalGear') {
    const { outerRadius } = getInternalGearRadii(shape);
    const availableDiameter = Math.max(
      getInternalGearMinimumOuterDiameter(shape),
      Math.min(
        shape.x - fullConstraint.minX,
        fullConstraint.maxX - shape.x,
        shape.y - fullConstraint.minY,
        fullConstraint.maxY - shape.y,
      ) * 2,
    );
    return {
      x: { min: fullConstraint.minX + outerRadius, max: fullConstraint.maxX - outerRadius },
      y: { min: fullConstraint.minY + outerRadius, max: fullConstraint.maxY - outerRadius },
      module: {
        min: GEAR_MODULE_MIN,
        max: getInternalGearMaximumModule(shape, shape.outerDiameter),
      },
      teeth: {
        min: INTERNAL_GEAR_TEETH_MIN,
        max: Math.min(INTERNAL_GEAR_TEETH_MAX, getInternalGearMaximumTeeth(shape, shape.outerDiameter)),
      },
      outerDiameter: {
        min: getInternalGearMinimumOuterDiameter(shape),
        max: availableDiameter,
      },
    };
  }
  if (shape.type === 'rack') {
    const dimensions = getRackGearDimensions(shape);
    const vertical = dimensions.rotation === 90 || dimensions.rotation === 270;
    const availableX = Math.max(0, fullConstraint.maxX - shape.x);
    const availableY = Math.max(0, fullConstraint.maxY - shape.y);
    const availableRackWidth = vertical ? availableY : availableX;
    const availableRackHeight = vertical ? availableX : availableY;
    return {
      x: { min: fullConstraint.minX, max: Math.max(fullConstraint.minX, fullConstraint.maxX - dimensions.boundsWidth) },
      y: { min: fullConstraint.minY, max: Math.max(fullConstraint.minY, fullConstraint.maxY - dimensions.boundsHeight) },
      width: {
        min: dimensions.profileWidth,
        max: Math.max(
          dimensions.profileWidth,
          Math.min(dimensions.maximumWidth, floorToModelPrecision(availableRackWidth)),
        ),
      },
      module: {
        min: GEAR_MODULE_MIN,
        max: Math.max(
          GEAR_MODULE_MIN,
          roundToModelPrecision(
            Math.min(GEAR_MODULE_MAX, availableRackWidth / (Math.PI * shape.teeth), shape.height / 2.25),
          ),
        ),
      },
      teeth: {
        min: RACK_TEETH_MIN,
        max: Math.max(
          RACK_TEETH_MIN,
          Math.min(RACK_TEETH_MAX, Math.floor(availableRackWidth / (Math.PI * shape.module))),
        ),
      },
      height: {
        min: dimensions.minimumHeight,
        max: Math.max(
          dimensions.minimumHeight,
          Math.min(RACK_HEIGHT_MAX, floorToModelPrecision(availableRackHeight)),
        ),
      },
    };
  }

  return {
    x: { min: fullConstraint.minX, max: Math.max(fullConstraint.minX, fullConstraint.maxX - shape.w) },
    y: { min: fullConstraint.minY, max: Math.max(fullConstraint.minY, fullConstraint.maxY - shape.h) },
    w: { min: 1, max: Math.max(1, fullConstraint.maxX - shape.x) },
    h: { min: 1, max: Math.max(1, fullConstraint.maxY - shape.y) },
  };
}

function getLockedRangeForDimension(document, dimension) {
  const ranges = FACE_ORDER.flatMap((face) => {
    if (!document.areaLocks?.[face]) {
      return [];
    }
    const constraint = normalizeConstraint(document.areaLockConstraints?.[face]);
    if (!constraint) {
      return [];
    }

    return Object.entries(FACE_AXES[face])
      .filter(([, axisDimension]) => axisDimension === dimension)
      .map(([axis]) => ({
        min: axis === 'x' ? constraint.minX : constraint.minY,
        max: axis === 'x' ? constraint.maxX : constraint.maxY,
      }));
  });

  if (!ranges.length) {
    return null;
  }

  const min = Math.max(...ranges.map((range) => range.min));
  const max = Math.min(...ranges.map((range) => range.max));
  return max > min ? { min, max, size: max - min } : null;
}

function getLockedPreviewDimensions(document) {
  if (!FACE_ORDER.every((face) => document.areaLocks?.[face])) {
    return null;
  }

  const width = getLockedRangeForDimension(document, 'width');
  const depth = getLockedRangeForDimension(document, 'depth');
  const height = getLockedRangeForDimension(document, 'height');
  if (!width || !depth || !height) {
    return null;
  }

  return { width, depth, height };
}

function getRangeFromBounds(face, axis, bounds) {
  if (!bounds) {
    return null;
  }
  return {
    dimension: FACE_AXES[face][axis],
    min: axis === 'x' ? bounds.minX : bounds.minY,
    max: axis === 'x' ? bounds.maxX : bounds.maxY,
  };
}

function intersectDimensionRanges(ranges) {
  const validRanges = ranges.filter(Boolean);
  if (!validRanges.length) {
    return null;
  }
  const min = Math.max(...validRanges.map((range) => range.min));
  const max = Math.min(...validRanges.map((range) => range.max));
  if (max > min) {
    return { min, max, size: max - min };
  }

  const fallbackMin = Math.min(...validRanges.map((range) => range.min));
  const fallbackMax = Math.max(...validRanges.map((range) => range.max));
  return fallbackMax > fallbackMin ? { min: fallbackMin, max: fallbackMax, size: fallbackMax - fallbackMin } : null;
}

function getPreviewDimensionsFromFaceBounds(document) {
  const faceBounds = getAllFaceBounds(document.shapes);
  const rangesByDimension = {
    width: [],
    depth: [],
    height: [],
  };

  FACE_ORDER.forEach((face) => {
    ['x', 'y'].forEach((axis) => {
      const range = getRangeFromBounds(face, axis, faceBounds[face]);
      if (range) {
        rangesByDimension[range.dimension].push(range);
      }
    });
  });

  const dimensions = {
    width: intersectDimensionRanges(rangesByDimension.width),
    depth: intersectDimensionRanges(rangesByDimension.depth),
    height: intersectDimensionRanges(rangesByDimension.height),
  };

  return dimensions.width && dimensions.depth && dimensions.height ? dimensions : null;
}

function getDocumentPreviewDimensions(documentData) {
  const normalizedDocument = normalizeModelPrecision(documentData);
  return getLockedPreviewDimensions(normalizedDocument) ?? getPreviewDimensionsFromFaceBounds(normalizedDocument);
}

function getAutomaticExportPreparation(documentData) {
  const normalizedDocument = normalizeModelPrecision(documentData);
  const faceBounds = getAllFaceBounds(normalizedDocument.shapes);
  const diagnostic = diagnoseProjectionConsistency(faceBounds);
  if (!diagnostic.valid) {
    if (hasNativeGeometry(documentData) && documentData.cad.features.every(f => f.input !== 'projection-base')) {
      return { document: normalizedDocument, dimensions: null };
    }
    const details = [
      ...diagnostic.missingFaces.map((face) => `${FACE_LABELS[face]}に有効なadd外形がありません`),
      ...diagnostic.mismatches.map((mismatch) => (
        `${DIMENSION_LABELS[mismatch.dimension]}: ` +
        `${FACE_LABELS[mismatch.first.face]} ${formatRange(mismatch.firstRange.min, mismatch.firstRange.max)} / ` +
        `${FACE_LABELS[mismatch.second.face]} ${formatRange(mismatch.secondRange.min, mismatch.secondRange.max)}`
      )),
    ];
    throw new Error(`3面ロック不可: ${details.join('、')}`);
  }

  const lockedDocument = normalizeModelPrecision(createLockedDocumentFromBounds(normalizedDocument, faceBounds));
  const dimensions = getLockedPreviewDimensions(lockedDocument);
  if (!dimensions) {
    throw new Error('3D寸法を確定できませんでした。');
  }
  return { document: lockedDocument, dimensions };
}

function pointInShape(shape, x, y) {
  if (shape.type === 'circle') {
    return ((x - shape.x) ** 2) + ((y - shape.y) ** 2) <= shape.r ** 2;
  }
  if (shape.type === 'gear') {
    return pointInGearOuter(shape, x, y) && getGearBoreSignedDistance(shape, x, y) >= 0;
  }
  if (shape.type === 'internalGear') {
    return pointInInternalGear(shape, x, y);
  }
  if (shape.type === 'rack') {
    return pointInRackGear(shape, x, y);
  }

  return x >= shape.x && x <= shape.x + shape.w && y >= shape.y && y <= shape.y + shape.h;
}

function pointInFaceSolid(shapes, face, x, y) {
  const faceShapes = shapes.filter((shape) => normalizeFace(shape.face) === face);
  return faceShapes.reduce((solid, shape) => {
    if (shape.type === 'gear' && shape.mode === 'add') {
      if (getGearBoreSignedDistance(shape, x, y) < 0) {
        return false;
      }
      return pointInGearOuter(shape, x, y) ? true : solid;
    }
    if (shape.type === 'internalGear' && shape.mode === 'add') {
      if (getInternalGearInnerSignedDistance(shape, x, y) < 0) {
        return false;
      }
      return getInternalGearOuterSignedDistance(shape, x, y) >= 0 ? true : solid;
    }
    if (!pointInShape(shape, x, y)) {
      return solid;
    }
    return shape.mode === 'add';
  }, false);
}

function getShapeSignedDistance(shape, x, y) {
  if (shape.type === 'circle') {
    return shape.r - Math.hypot(x - shape.x, y - shape.y);
  }
  if (shape.type === 'gear') {
    return Math.min(
      getGearOuterSignedDistance(shape, x, y),
      getGearBoreSignedDistance(shape, x, y),
    );
  }
  if (shape.type === 'internalGear') {
    return Math.min(
      getInternalGearOuterSignedDistance(shape, x, y),
      getInternalGearInnerSignedDistance(shape, x, y),
    );
  }
  if (shape.type === 'rack') {
    return getRackGearSignedDistance(shape, x, y);
  }

  const left = shape.x;
  const right = shape.x + shape.w;
  const top = shape.y;
  const bottom = shape.y + shape.h;
  const outsideX = Math.max(left - x, 0, x - right);
  const outsideY = Math.max(top - y, 0, y - bottom);
  if (outsideX > 0 || outsideY > 0) {
    return -Math.hypot(outsideX, outsideY);
  }

  return Math.min(x - left, right - x, y - top, bottom - y);
}

function getFaceSignedDistance(faceShapes, x, y) {
  return faceShapes.reduce((distance, shape) => {
    if (shape.type === 'gear' && shape.mode === 'add') {
      const withGear = Math.max(distance, getGearOuterSignedDistance(shape, x, y));
      return Math.min(withGear, getGearBoreSignedDistance(shape, x, y));
    }
    if (shape.type === 'internalGear' && shape.mode === 'add') {
      const withOuter = Math.max(distance, getInternalGearOuterSignedDistance(shape, x, y));
      return Math.min(withOuter, getInternalGearInnerSignedDistance(shape, x, y));
    }
    const shapeDistance = getShapeSignedDistance(shape, x, y);
    if (shape.mode === 'add') {
      return Math.max(distance, shapeDistance);
    }
    return Math.min(distance, -shapeDistance);
  }, -1_000_000);
}

function isVoxelSolid(shapes, dimensions, x, depth, height) {
  return (
    pointInFaceSolid(shapes, 'top', x, depth) &&
    pointInFaceSolid(shapes, 'front', x, height) &&
    pointInFaceSolid(shapes, 'right', depth, height)
  );
}

function getVoxelKey(xIndex, depthIndex, heightIndex) {
  return `${xIndex}:${depthIndex}:${heightIndex}`;
}

function getVoxelCorners(x0, x1, y0, y1, z0, z1) {
  return [
    { x: x0, y: y0, z: z0 },
    { x: x1, y: y0, z: z0 },
    { x: x1, y: y1, z: z0 },
    { x: x0, y: y1, z: z0 },
    { x: x0, y: y0, z: z1 },
    { x: x1, y: y0, z: z1 },
    { x: x1, y: y1, z: z1 },
    { x: x0, y: y1, z: z1 },
  ];
}

function buildSolidPreviewFaces(shapes, dimensions) {
  const stepCounts = {
    x: SOLID_PREVIEW_STEPS,
    y: SOLID_PREVIEW_STEPS,
    z: SOLID_PREVIEW_STEPS,
  };
  const cell = {
    x: dimensions.width.size / stepCounts.x,
    y: dimensions.depth.size / stepCounts.y,
    z: dimensions.height.size / stepCounts.z,
  };
  const solidCells = new Set();

  for (let xIndex = 0; xIndex < stepCounts.x; xIndex += 1) {
    for (let yIndex = 0; yIndex < stepCounts.y; yIndex += 1) {
      for (let zIndex = 0; zIndex < stepCounts.z; zIndex += 1) {
        const x = dimensions.width.min + (xIndex + 0.5) * cell.x;
        const depth = dimensions.depth.min + (yIndex + 0.5) * cell.y;
        const height = dimensions.height.min + (zIndex + 0.5) * cell.z;
        if (isVoxelSolid(shapes, dimensions, x, depth, height)) {
          solidCells.add(getVoxelKey(xIndex, yIndex, zIndex));
        }
      }
    }
  }

  const faceDefinitions = [
    { neighbor: [0, 0, 1], className: 'iso-preview-top', indexes: [4, 5, 6, 7] },
    { neighbor: [0, -1, 0], className: 'iso-preview-front', indexes: [0, 1, 5, 4] },
    { neighbor: [1, 0, 0], className: 'iso-preview-right', indexes: [1, 2, 6, 5] },
    { neighbor: [0, 0, -1], className: 'iso-preview-bottom', indexes: [0, 3, 2, 1] },
    { neighbor: [0, 1, 0], className: 'iso-preview-back', indexes: [3, 2, 6, 7] },
    { neighbor: [-1, 0, 0], className: 'iso-preview-left', indexes: [0, 3, 7, 4] },
  ];
  const faces = [];

  for (let xIndex = 0; xIndex < stepCounts.x; xIndex += 1) {
    for (let yIndex = 0; yIndex < stepCounts.y; yIndex += 1) {
      for (let zIndex = 0; zIndex < stepCounts.z; zIndex += 1) {
        if (!solidCells.has(getVoxelKey(xIndex, yIndex, zIndex))) {
          continue;
        }

        const x0 = xIndex * cell.x - dimensions.width.size / 2;
        const x1 = (xIndex + 1) * cell.x - dimensions.width.size / 2;
        const y0 = yIndex * cell.y - dimensions.depth.size / 2;
        const y1 = (yIndex + 1) * cell.y - dimensions.depth.size / 2;
        const z0 = zIndex * cell.z - dimensions.height.size / 2;
        const z1 = (zIndex + 1) * cell.z - dimensions.height.size / 2;
        const corners = getVoxelCorners(x0, x1, y0, y1, z0, z1);

        faceDefinitions.forEach((definition) => {
          const [dx, dy, dz] = definition.neighbor;
          const neighborKey = getVoxelKey(xIndex + dx, yIndex + dy, zIndex + dz);
          if (!solidCells.has(neighborKey)) {
            faces.push({
              className: definition.className,
              corners: definition.indexes.map((index) => corners[index]),
            });
          }
        });
      }
    }
  }

  return faces;
}

function centeredCoordinate(value, dimension) {
  return value - dimension.min - dimension.size / 2;
}

function getShapePlanRing(shape, circleSegments = CIRCLE_MESH_SEGMENTS) {
  if (shape.type === 'circle') {
    return Array.from({ length: circleSegments }, (_, index) => {
      const angle = (Math.PI * 2 * index) / circleSegments;
      return [
        shape.x + Math.cos(angle) * shape.r,
        shape.y + Math.sin(angle) * shape.r,
      ];
    });
  }
  if (shape.type === 'gear') {
    return getGearOutlineRing(shape, Math.max(3, Math.round(circleSegments / 16)));
  }
  if (shape.type === 'internalGear') {
    return getInternalGearOuterRing(shape, Math.max(64, circleSegments));
  }
  if (shape.type === 'rack') {
    return getRackGearOutlineRing(shape);
  }

  return [
    [shape.x, shape.y],
    [shape.x + shape.w, shape.y],
    [shape.x + shape.w, shape.y + shape.h],
    [shape.x, shape.y + shape.h],
  ];
}

function getShapeMultiPolygon(shape, circleSegments = CIRCLE_MESH_SEGMENTS) {
  return [[getShapePlanRing(shape, circleSegments)]];
}

function ringsEqualPoint(first, second) {
  return Math.abs(first[0] - second[0]) < 0.0001 && Math.abs(first[1] - second[1]) < 0.0001;
}

function normalizePlanRing(ring) {
  const normalized = ring.filter((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]));
  if (normalized.length > 1 && ringsEqualPoint(normalized[0], normalized[normalized.length - 1])) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

const FACE_BOOLEAN_POLYGON_CACHE_MAX = 48;
const FACE_BOOLEAN_POLYGON_CACHE = new Map();

function getFaceBooleanPolygons(faceShapes, circleSegments = CIRCLE_MESH_SEGMENTS) {
  const cacheKey = `${circleSegments}:${JSON.stringify(faceShapes)}`;
  const cached = FACE_BOOLEAN_POLYGON_CACHE.get(cacheKey);
  if (cached) {
    return cached;
  }
  const solid = faceShapes.reduce((result, shape) => {
    const shapePolygon = getShapeMultiPolygon(shape, circleSegments);
    if (shape.mode === 'add') {
      const added = normalizeMultiPolygon(
        result.length ? polygonClipping.union(result, shapePolygon) : shapePolygon,
      );
      if (shape.type === 'gear' && shape.bore > 0) {
        const borePolygon = [[getGearBoreRing(shape, circleSegments)]];
        return normalizeMultiPolygon(polygonClipping.difference(added, borePolygon));
      }
      if (shape.type === 'internalGear') {
        const innerPolygon = [[getInternalGearInnerRing(shape)]];
        return normalizeMultiPolygon(polygonClipping.difference(added, innerPolygon));
      }
      return added;
    }
    if (!result.length) {
      return [];
    }
    return normalizeMultiPolygon(polygonClipping.difference(result, shapePolygon));
  }, []);

  const normalized = normalizeMultiPolygon(solid);
  if (FACE_BOOLEAN_POLYGON_CACHE.size >= FACE_BOOLEAN_POLYGON_CACHE_MAX) {
    FACE_BOOLEAN_POLYGON_CACHE.delete(FACE_BOOLEAN_POLYGON_CACHE.keys().next().value);
  }
  FACE_BOOLEAN_POLYGON_CACHE.set(cacheKey, normalized);
  return normalized;
}

function getBooleanPolygonBounds(polygons) {
  const points = polygons.flatMap((polygon) => polygon.flatMap((ring) => ring));
  if (!points.length) {
    return null;
  }

  return {
    minX: clampRangeValue(Math.min(...points.map(([x]) => x))),
    maxX: clampRangeValue(Math.max(...points.map(([x]) => x))),
    minY: clampRangeValue(Math.min(...points.map(([, y]) => y))),
    maxY: clampRangeValue(Math.max(...points.map(([, y]) => y))),
  };
}

function isPointOnSegment(point, start, end) {
  const [x, y] = point;
  const [x1, y1] = start;
  const [x2, y2] = end;
  const cross = (x - x1) * (y2 - y1) - (y - y1) * (x2 - x1);
  if (Math.abs(cross) > 0.0001) {
    return false;
  }
  return (
    x >= Math.min(x1, x2) - 0.0001 &&
    x <= Math.max(x1, x2) + 0.0001 &&
    y >= Math.min(y1, y2) - 0.0001 &&
    y <= Math.max(y1, y2) + 0.0001
  );
}

function pointInPlanRing(point, ring) {
  let inside = false;
  ring.forEach((start, index) => {
    const end = ring[(index + 1) % ring.length];
    if (isPointOnSegment(point, start, end)) {
      inside = true;
      return;
    }
    const intersects = ((start[1] > point[1]) !== (end[1] > point[1])) &&
      point[0] < ((end[0] - start[0]) * (point[1] - start[1])) / (end[1] - start[1]) + start[0];
    if (intersects) {
      inside = !inside;
    }
  });
  return inside;
}

function pointInFacePolygons(polygons, u, v) {
  return polygons.some((polygon) => {
    if (!pointInPlanRing([u, v], polygon[0])) {
      return false;
    }
    return !polygon.slice(1).some((ring) => pointInPlanRing([u, v], ring));
  });
}

function collectPlanCoordinates(polygons, axis) {
  return polygons.flatMap((polygon) =>
    polygon.flatMap((ring) => ring.map((point) => point[axis])),
  );
}

function getAxisStops(values, dimension) {
  return [...values, dimension.min, dimension.max]
    .filter((value) => Number.isFinite(value))
    .map((value) => clampValue(value, dimension.min, dimension.max))
    .sort((a, b) => a - b)
    .filter((value, index, sorted) => index === 0 || Math.abs(value - sorted[index - 1]) > 0.001);
}

function normalizeMultiPolygon(multiPolygon) {
  return multiPolygon
    .map((polygon) => polygon.map(normalizePlanRing).filter((ring) => ring.length >= 3))
    .filter((polygon) => polygon.length);
}

function normalizeIntervals(intervals) {
  return intervals
    .filter(([start, end]) => end - start > 0.001)
    .sort((a, b) => a[0] - b[0])
    .reduce((merged, interval) => {
      const previous = merged[merged.length - 1];
      if (!previous || interval[0] > previous[1] + 0.001) {
        merged.push([...interval]);
        return merged;
      }
      previous[1] = Math.max(previous[1], interval[1]);
      return merged;
    }, []);
}

function subtractIntervals(baseIntervals, cutIntervals) {
  const cuts = normalizeIntervals(cutIntervals);
  return normalizeIntervals(baseIntervals).flatMap(([baseStart, baseEnd]) => {
    let parts = [[baseStart, baseEnd]];
    cuts.forEach(([cutStart, cutEnd]) => {
      parts = parts.flatMap(([start, end]) => {
        if (cutEnd <= start || cutStart >= end) {
          return [[start, end]];
        }
        return [
          [start, Math.max(start, cutStart)],
          [Math.min(end, cutEnd), end],
        ].filter(([nextStart, nextEnd]) => nextEnd - nextStart > 0.001);
      });
    });
    return parts;
  });
}

function intersectIntervalSets(firstIntervals, secondIntervals) {
  const first = normalizeIntervals(firstIntervals);
  const second = normalizeIntervals(secondIntervals);
  const intersections = [];
  let firstIndex = 0;
  let secondIndex = 0;

  while (firstIndex < first.length && secondIndex < second.length) {
    const [firstStart, firstEnd] = first[firstIndex];
    const [secondStart, secondEnd] = second[secondIndex];
    const start = Math.max(firstStart, secondStart);
    const end = Math.min(firstEnd, secondEnd);
    if (end - start > 0.001) {
      intersections.push([start, end]);
    }
    if (firstEnd < secondEnd) {
      firstIndex += 1;
    } else {
      secondIndex += 1;
    }
  }

  return normalizeIntervals(intersections);
}

function clampIntervalsToDimension(intervals, dimension) {
  return normalizeIntervals(intervals.map(([start, end]) => [
    clampValue(start, dimension.min, dimension.max),
    clampValue(end, dimension.min, dimension.max),
  ]));
}

function getRingLineIntervals(ring, fixedValue, fixedAxis) {
  const variableAxis = fixedAxis === 0 ? 1 : 0;
  const intersections = [];
  ring.forEach((start, index) => {
    const end = ring[(index + 1) % ring.length];
    const startFixed = start[fixedAxis];
    const endFixed = end[fixedAxis];
    if ((startFixed > fixedValue) === (endFixed > fixedValue)) {
      return;
    }
    const ratio = (fixedValue - startFixed) / (endFixed - startFixed);
    intersections.push(start[variableAxis] + (end[variableAxis] - start[variableAxis]) * ratio);
  });
  return intersections
    .sort((a, b) => a - b)
    .reduce((intervals, value, index, sorted) => {
      if (index % 2 === 0 && sorted[index + 1] !== undefined) {
        intervals.push([value, sorted[index + 1]]);
      }
      return intervals;
    }, []);
}

function getLineIntervalsForPolygons(polygons, fixedValue, fixedAxis) {
  return normalizeIntervals(polygons.flatMap((polygon) => {
    const outerIntervals = getRingLineIntervals(polygon[0], fixedValue, fixedAxis);
    const holeIntervals = polygon.slice(1).flatMap((ring) =>
      getRingLineIntervals(ring, fixedValue, fixedAxis),
    );
    return subtractIntervals(outerIntervals, holeIntervals);
  }));
}

function getIntervalRectangles(firstIntervals, secondIntervals) {
  return firstIntervals.flatMap(([firstStart, firstEnd]) =>
    secondIntervals.map(([secondStart, secondEnd]) => [[
      [firstStart, secondStart],
      [firstEnd, secondStart],
      [firstEnd, secondEnd],
      [firstStart, secondEnd],
    ]]),
  );
}

function intersectPolygonsWithIntervals(basePolygons, firstIntervals, secondIntervals) {
  const rectangles = getIntervalRectangles(firstIntervals, secondIntervals);
  if (!basePolygons.length || !rectangles.length) {
    return [];
  }
  const clipPolygons = rectangles.length === 1 ? rectangles : polygonClipping.union(...rectangles);
  return normalizeMultiPolygon(polygonClipping.intersection(basePolygons, clipPolygons));
}

function differencePolygons(basePolygons, cutPolygons) {
  if (!basePolygons.length) {
    return [];
  }
  if (!cutPolygons.length) {
    return basePolygons;
  }
  return normalizeMultiPolygon(polygonClipping.difference(basePolygons, cutPolygons));
}

function getSectionSample(value, dimension, direction) {
  const sample = value + direction * SECTION_SAMPLE_EPSILON;
  if (sample <= dimension.min || sample >= dimension.max) {
    return null;
  }
  return sample;
}

function getExtrudedSurfacePoint(face, u, v, t, dimensions) {
  if (face === 'top') {
    return {
      x: centeredCoordinate(u, dimensions.width),
      y: centeredCoordinate(v, dimensions.depth),
      z: centeredCoordinate(t, dimensions.height),
    };
  }
  if (face === 'front') {
    return {
      x: centeredCoordinate(u, dimensions.width),
      y: centeredCoordinate(t, dimensions.depth),
      z: centeredCoordinate(v, dimensions.height),
    };
  }
  return {
    x: centeredCoordinate(t, dimensions.width),
    y: centeredCoordinate(u, dimensions.depth),
    z: centeredCoordinate(v, dimensions.height),
  };
}

function getExtrusionIntervals(face, u, v, polygonsByFace, dimensions) {
  if (face === 'top') {
    return clampIntervalsToDimension(
      intersectIntervalSets(
        getLineIntervalsForPolygons(polygonsByFace.front, u, 0),
        getLineIntervalsForPolygons(polygonsByFace.right, v, 0),
      ),
      dimensions.height,
    );
  }
  if (face === 'front') {
    return clampIntervalsToDimension(
      intersectIntervalSets(
        getLineIntervalsForPolygons(polygonsByFace.top, u, 0),
        getLineIntervalsForPolygons(polygonsByFace.right, v, 1),
      ),
      dimensions.depth,
    );
  }
  return clampIntervalsToDimension(
    intersectIntervalSets(
      getLineIntervalsForPolygons(polygonsByFace.top, u, 1),
      getLineIntervalsForPolygons(polygonsByFace.front, v, 1),
    ),
    dimensions.width,
  );
}

function getConstrainedWallClass(face, point, next, fallbackClassName, dimensions) {
  if (fallbackClassName === 'iso-preview-cut-side') {
    return fallbackClassName;
  }
  if (face === 'front' && Math.abs(point[1] - next[1]) < 0.0001) {
    const midHeight = dimensions.height.min + dimensions.height.size / 2;
    return point[1] >= midHeight ? 'iso-preview-top' : 'iso-preview-bottom';
  }
  if (face === 'right' && Math.abs(point[1] - next[1]) < 0.0001) {
    const midHeight = dimensions.height.min + dimensions.height.size / 2;
    return point[1] >= midHeight ? 'iso-preview-top' : 'iso-preview-bottom';
  }
  return `iso-preview-side ${fallbackClassName}`;
}

function buildConstrainedRingWalls(planRing, face, className, polygonsByFace, dimensions) {
  return planRing.flatMap((point, index) => {
    const next = planRing[(index + 1) % planRing.length];
    if (Math.abs(point[0] - next[0]) < 0.0001 || Math.abs(point[1] - next[1]) < 0.0001) {
      return [];
    }
    const u = (point[0] + next[0]) / 2;
    const v = (point[1] + next[1]) / 2;
    const wallClassName = getConstrainedWallClass(face, point, next, className, dimensions);
    return getExtrusionIntervals(face, u, v, polygonsByFace, dimensions).map(([start, end]) => {
      return {
        className: wallClassName,
        rings: [[
          getExtrudedSurfacePoint(face, point[0], point[1], start, dimensions),
          getExtrudedSurfacePoint(face, next[0], next[1], start, dimensions),
          getExtrudedSurfacePoint(face, next[0], next[1], end, dimensions),
          getExtrudedSurfacePoint(face, point[0], point[1], end, dimensions),
        ]],
        edge: !wallClassName.includes('iso-preview-cut-side'),
      };
    });
  });
}

function getZSectionPolygons(z, polygonsByFace) {
  const xIntervals = getLineIntervalsForPolygons(polygonsByFace.front, z, 1);
  const yIntervals = getLineIntervalsForPolygons(polygonsByFace.right, z, 1);
  return intersectPolygonsWithIntervals(polygonsByFace.top, xIntervals, yIntervals);
}

function getYSectionPolygons(y, polygonsByFace) {
  const xIntervals = getLineIntervalsForPolygons(polygonsByFace.top, y, 1);
  const zIntervals = getLineIntervalsForPolygons(polygonsByFace.right, y, 0);
  return intersectPolygonsWithIntervals(polygonsByFace.front, xIntervals, zIntervals);
}

function getXSectionPolygons(x, polygonsByFace) {
  const yIntervals = getLineIntervalsForPolygons(polygonsByFace.top, x, 0);
  const zIntervals = getLineIntervalsForPolygons(polygonsByFace.front, x, 0);
  return intersectPolygonsWithIntervals(polygonsByFace.right, yIntervals, zIntervals);
}

function mapSectionPolygonToSurface(polygon, plane, value, dimensions, className) {
  return {
    className,
    rings: polygon.map((ring) => ring.map(([first, second]) => {
      if (plane === 'z') {
        return getExtrudedSurfacePoint('top', first, second, value, dimensions);
      }
      if (plane === 'y') {
        return getExtrudedSurfacePoint('front', first, second, value, dimensions);
      }
      return getExtrudedSurfacePoint('right', first, second, value, dimensions);
    })),
    edge: true,
  };
}

function buildSectionSurfaces(stops, dimension, getSectionPolygons, plane, negativeClassName, positiveClassName, dimensions) {
  return stops.flatMap((value) => {
    const beforeSample = getSectionSample(value, dimension, -1);
    const afterSample = getSectionSample(value, dimension, 1);
    const before = beforeSample === null ? [] : getSectionPolygons(beforeSample);
    const after = afterSample === null ? [] : getSectionPolygons(afterSample);
    const negativeSurfaces = differencePolygons(after, before)
      .map((polygon) => mapSectionPolygonToSurface(polygon, plane, value, dimensions, negativeClassName));
    const positiveSurfaces = differencePolygons(before, after)
      .map((polygon) => mapSectionPolygonToSurface(polygon, plane, value, dimensions, positiveClassName));
    return [...negativeSurfaces, ...positiveSurfaces];
  });
}

function buildSurfacePreviewFaces(shapes, dimensions, options = {}) {
  const circleSegments = options.circleSegments ?? CIRCLE_MESH_SEGMENTS;
  const polygonsByFace = Object.fromEntries(
    FACE_ORDER.map((face) => [
      face,
      getFaceBooleanPolygons(
        shapes.filter((shape) => normalizeFace(shape.face) === face),
        circleSegments,
      ),
    ]),
  );
  if (FACE_ORDER.some((face) => !polygonsByFace[face].length)) {
    return [];
  }

  const facePairs = [
    { source: 'top', className: 'iso-preview-top' },
    { source: 'front', className: 'iso-preview-front' },
    { source: 'right', className: 'iso-preview-right' },
  ];

  const zStops = getAxisStops([
    ...collectPlanCoordinates(polygonsByFace.front, 1),
    ...collectPlanCoordinates(polygonsByFace.right, 1),
  ], dimensions.height);
  const yStops = getAxisStops([
    ...collectPlanCoordinates(polygonsByFace.top, 1),
    ...collectPlanCoordinates(polygonsByFace.right, 0),
  ], dimensions.depth);
  const xStops = getAxisStops([
    ...collectPlanCoordinates(polygonsByFace.top, 0),
    ...collectPlanCoordinates(polygonsByFace.front, 0),
  ], dimensions.width);

  const sectionSurfaces = [
    ...buildSectionSurfaces(
      zStops,
      dimensions.height,
      (z) => getZSectionPolygons(z, polygonsByFace),
      'z',
      'iso-preview-bottom',
      'iso-preview-top',
      dimensions,
    ),
    ...buildSectionSurfaces(
      yStops,
      dimensions.depth,
      (y) => getYSectionPolygons(y, polygonsByFace),
      'y',
      'iso-preview-front',
      'iso-preview-back',
      dimensions,
    ),
    ...buildSectionSurfaces(
      xStops,
      dimensions.width,
      (x) => getXSectionPolygons(x, polygonsByFace),
      'x',
      'iso-preview-left',
      'iso-preview-right',
      dimensions,
    ),
  ];

  const sweptSurfaces = facePairs.flatMap(({ source, className }) =>
    polygonsByFace[source].flatMap((polygon) => {
      return polygon.flatMap((ring, index) =>
        buildConstrainedRingWalls(
          ring,
          source,
          index === 0 ? className : 'iso-preview-cut-side',
          polygonsByFace,
          dimensions,
        ),
      );
    }),
  );

  return [...sectionSurfaces, ...sweptSurfaces];
}

function subtractPoint(a, b) {
  return {
    x: a.x - b.x,
    y: a.y - b.y,
    z: a.z - b.z,
  };
}

function crossProduct(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function dotProduct(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function normalizeVector(vector) {
  const length = Math.hypot(vector.x, vector.y, vector.z);
  if (length < 0.000001) {
    return null;
  }
  return {
    x: vector.x / length,
    y: vector.y / length,
    z: vector.z / length,
  };
}

function getRingNormal(ring) {
  const normal = ring.reduce((sum, point, index) => {
    const next = ring[(index + 1) % ring.length];
    return {
      x: sum.x + (point.y - next.y) * (point.z + next.z),
      y: sum.y + (point.z - next.z) * (point.x + next.x),
      z: sum.z + (point.x - next.x) * (point.y + next.y),
    };
  }, { x: 0, y: 0, z: 0 });
  return normalizeVector(normal) ?? { x: 0, y: 0, z: 1 };
}

function getProjectionAxes(normal) {
  const absolute = {
    x: Math.abs(normal.x),
    y: Math.abs(normal.y),
    z: Math.abs(normal.z),
  };
  if (absolute.x >= absolute.y && absolute.x >= absolute.z) {
    return ['y', 'z'];
  }
  if (absolute.y >= absolute.x && absolute.y >= absolute.z) {
    return ['x', 'z'];
  }
  return ['x', 'y'];
}

function getTriangleNormal(a, b, c) {
  return normalizeVector(crossProduct(subtractPoint(b, a), subtractPoint(c, a)));
}

function triangulateSurface(surface) {
  const outerRing = surface.rings[0];
  if (!outerRing || outerRing.length < 3) {
    return [];
  }
  const targetNormal = getRingNormal(outerRing);
  const axes = getProjectionAxes(targetNormal);
  const points = [];
  const flat = [];
  const holes = [];

  surface.rings.forEach((ring, index) => {
    if (ring.length < 3) {
      return;
    }
    if (index > 0) {
      holes.push(points.length);
    }
    ring.forEach((point) => {
      points.push(point);
      flat.push(point[axes[0]], point[axes[1]]);
    });
  });

  return earcut(flat, holes, 2).reduce((triangles, pointIndex, index, indexes) => {
    if (index % 3 !== 0) {
      return triangles;
    }
    let a = points[pointIndex];
    let b = points[indexes[index + 1]];
    let c = points[indexes[index + 2]];
    let normal = getTriangleNormal(a, b, c);
    if (!normal) {
      return triangles;
    }
    if (dotProduct(normal, targetNormal) < 0) {
      [b, c] = [c, b];
      normal = getTriangleNormal(a, b, c);
    }
    if (!normal) {
      return triangles;
    }
    triangles.push({ normal, vertices: [a, b, c] });
    return triangles;
  }, []);
}

function formatStlNumber(value) {
  if (Math.abs(value) < 0.000001) {
    return '0';
  }
  return Number(value.toFixed(6)).toString();
}

function getOutputBaseName(documentData) {
  return (documentData.partName || 'oshidasumaho-cad-output')
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-') || 'oshidasumaho-cad-output';
}

const STL_MESH_OPTIONS = {
  baseCellSize: STL_VOXEL_CELL_SIZE,
  maxAxisSteps: STL_VOXEL_MAX_AXIS_STEPS,
  maxCells: STL_VOXEL_MAX_CELLS,
  resolutionMax: STL_RESOLUTION_MAX,
};

function getMeshBaseCellSize(dimensions, options = STL_MESH_OPTIONS) {
  const maxSize = Math.max(dimensions.width.size, dimensions.depth.size, dimensions.height.size);
  return Math.max(options.baseCellSize, maxSize / options.maxAxisSteps);
}

function getStlSpanStepCounts(dimensions, cellSize) {
  return {
    x: Math.max(1, Math.ceil(dimensions.width.size / cellSize)),
    y: Math.max(1, Math.ceil(dimensions.depth.size / cellSize)),
    z: Math.max(1, Math.ceil(dimensions.height.size / cellSize)),
  };
}

function getMeshResolutionMax(dimensions, options = STL_MESH_OPTIONS) {
  if (!dimensions) {
    return 1;
  }

  const baseCellSize = getMeshBaseCellSize(dimensions, options);
  const baseSteps = getStlSpanStepCounts(dimensions, baseCellSize);
  const baseCells = baseSteps.x * baseSteps.y * baseSteps.z;
  const maxByCells = Math.cbrt(options.maxCells / Math.max(1, baseCells));
  return Math.max(1, Math.min(options.resolutionMax, Math.floor(maxByCells * 10) / 10));
}

function getStlVoxelGrid(dimensions, resolutionFactor = 1, options = STL_MESH_OPTIONS) {
  const resolutionMax = getMeshResolutionMax(dimensions, options);
  const requestedFactor = clampValue(Number(resolutionFactor) || 1, 1, resolutionMax);
  const targetCellSize = getMeshBaseCellSize(dimensions, options) / requestedFactor;
  const spanSteps = getStlSpanStepCounts(dimensions, targetCellSize);
  const cell = {
    x: dimensions.width.size / spanSteps.x,
    y: dimensions.depth.size / spanSteps.y,
    z: dimensions.height.size / spanSteps.z,
  };
  const stepCounts = {
    x: spanSteps.x + 2,
    y: spanSteps.y + 2,
    z: spanSteps.z + 2,
  };

  return {
    stepCounts,
    pointCounts: {
      x: stepCounts.x + 1,
      y: stepCounts.y + 1,
      z: stepCounts.z + 1,
    },
    cell,
    origin: {
      x: dimensions.width.min - cell.x,
      y: dimensions.depth.min - cell.y,
      z: dimensions.height.min - cell.z,
    },
  };
}

function getGridPointIndex(xIndex, yIndex, zIndex, pointCounts) {
  return (zIndex * pointCounts.y + yIndex) * pointCounts.x + xIndex;
}

function createStlAxisValues(count, start, step) {
  return Array.from({ length: count }, (_, index) => start + index * step);
}

function createFaceDistanceGrid(faceShapes, firstValues, secondValues) {
  const distances = new Float32Array(firstValues.length * secondValues.length);
  secondValues.forEach((second, secondIndex) => {
    firstValues.forEach((first, firstIndex) => {
      distances[secondIndex * firstValues.length + firstIndex] =
        getFaceSignedDistance(faceShapes, first, second);
    });
  });
  return distances;
}

function getCenteredStlPoint(x, y, z, dimensions) {
  return {
    x: centeredCoordinate(x, dimensions.width),
    y: centeredCoordinate(y, dimensions.depth),
    z: centeredCoordinate(z, dimensions.height),
  };
}

function getFaceShapesByFace(shapes) {
  return Object.fromEntries(
    FACE_ORDER.map((face) => [
      face,
      shapes.filter((shape) => normalizeFace(shape.face) === face),
    ]),
  );
}

function getSolidSignedDistance(faceShapesByFace, dimensions, point) {
  const x = point.x + dimensions.width.min + dimensions.width.size / 2;
  const y = point.y + dimensions.depth.min + dimensions.depth.size / 2;
  const z = point.z + dimensions.height.min + dimensions.height.size / 2;
  return Math.min(
    getFaceSignedDistance(faceShapesByFace.top, x, y),
    getFaceSignedDistance(faceShapesByFace.front, x, z),
    getFaceSignedDistance(faceShapesByFace.right, y, z),
  );
}

function createStlField(shapes, dimensions, resolutionFactor, options = STL_MESH_OPTIONS) {
  const grid = getStlVoxelGrid(dimensions, resolutionFactor, options);
  const { pointCounts, cell, origin } = grid;
  const xValues = createStlAxisValues(pointCounts.x, origin.x, cell.x);
  const yValues = createStlAxisValues(pointCounts.y, origin.y, cell.y);
  const zValues = createStlAxisValues(pointCounts.z, origin.z, cell.z);
  const faceShapesByFace = getFaceShapesByFace(shapes);
  const topDistances = createFaceDistanceGrid(faceShapesByFace.top, xValues, yValues);
  const frontDistances = createFaceDistanceGrid(faceShapesByFace.front, xValues, zValues);
  const rightDistances = createFaceDistanceGrid(faceShapesByFace.right, yValues, zValues);
  const values = new Float32Array(pointCounts.x * pointCounts.y * pointCounts.z);

  for (let zIndex = 0; zIndex < pointCounts.z; zIndex += 1) {
    for (let yIndex = 0; yIndex < pointCounts.y; yIndex += 1) {
      for (let xIndex = 0; xIndex < pointCounts.x; xIndex += 1) {
        values[getGridPointIndex(xIndex, yIndex, zIndex, pointCounts)] = Math.min(
          topDistances[yIndex * pointCounts.x + xIndex],
          frontDistances[zIndex * pointCounts.x + xIndex],
          rightDistances[zIndex * pointCounts.y + yIndex],
        );
      }
    }
  }

  return { ...grid, xValues, yValues, zValues, values, faceShapesByFace };
}

function getStlCorner(field, dimensions, xIndex, yIndex, zIndex) {
  const { pointCounts, xValues, yValues, zValues, values } = field;
  return {
    value: values[getGridPointIndex(xIndex, yIndex, zIndex, pointCounts)],
    point: getCenteredStlPoint(xValues[xIndex], yValues[yIndex], zValues[zIndex], dimensions),
  };
}

function interpolateStlCorner(first, second) {
  const ratio = first.value / (first.value - second.value);
  return {
    x: first.point.x + (second.point.x - first.point.x) * ratio,
    y: first.point.y + (second.point.y - first.point.y) * ratio,
    z: first.point.z + (second.point.z - first.point.z) * ratio,
  };
}

function pushOrientedStlTriangle(triangles, a, b, c, faceShapesByFace, dimensions, epsilon) {
  let normal = getTriangleNormal(a, b, c);
  if (!normal) {
    return;
  }

  const center = {
    x: (a.x + b.x + c.x) / 3,
    y: (a.y + b.y + c.y) / 3,
    z: (a.z + b.z + c.z) / 3,
  };
  const positiveSide = {
    x: center.x + normal.x * epsilon,
    y: center.y + normal.y * epsilon,
    z: center.z + normal.z * epsilon,
  };
  const negativeSide = {
    x: center.x - normal.x * epsilon,
    y: center.y - normal.y * epsilon,
    z: center.z - normal.z * epsilon,
  };

  if (
    getSolidSignedDistance(faceShapesByFace, dimensions, positiveSide) >
    getSolidSignedDistance(faceShapesByFace, dimensions, negativeSide)
  ) {
    [b, c] = [c, b];
    normal = getTriangleNormal(a, b, c);
  }
  if (!normal) {
    return;
  }
  triangles.push({ normal, vertices: [a, b, c] });
}

function pushMarchingTetraTriangles(triangles, corners, faceShapesByFace, dimensions, epsilon) {
  const inside = [];
  const outside = [];
  corners.forEach((corner, index) => {
    if (corner.value >= 0) {
      inside.push(index);
    } else {
      outside.push(index);
    }
  });

  if (inside.length === 0 || inside.length === 4) {
    return;
  }

  const edgePoint = (firstIndex, secondIndex) =>
    interpolateStlCorner(corners[firstIndex], corners[secondIndex]);

  if (inside.length === 1 || inside.length === 3) {
    const source = inside.length === 1 ? inside[0] : outside[0];
    const targets = inside.length === 1 ? outside : inside;
    const points = targets.map((target) => edgePoint(source, target));
    pushOrientedStlTriangle(triangles, points[0], points[1], points[2], faceShapesByFace, dimensions, epsilon);
    return;
  }

  const [firstInside, secondInside] = inside;
  const [firstOutside, secondOutside] = outside;
  const points = [
    edgePoint(firstInside, firstOutside),
    edgePoint(secondInside, firstOutside),
    edgePoint(secondInside, secondOutside),
    edgePoint(firstInside, secondOutside),
  ];
  pushOrientedStlTriangle(triangles, points[0], points[1], points[2], faceShapesByFace, dimensions, epsilon);
  pushOrientedStlTriangle(triangles, points[0], points[2], points[3], faceShapesByFace, dimensions, epsilon);
}

function buildMarchingStlTriangles(shapes, dimensions, resolutionFactor = 1, options = STL_MESH_OPTIONS) {
  const field = createStlField(shapes, dimensions, resolutionFactor, options);
  const { stepCounts, cell, faceShapesByFace } = field;
  const triangles = [];
  const cornerOffsets = [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
    [0, 0, 1],
    [1, 0, 1],
    [1, 1, 1],
    [0, 1, 1],
  ];
  const tetrahedra = [
    [0, 5, 1, 6],
    [0, 1, 2, 6],
    [0, 2, 3, 6],
    [0, 3, 7, 6],
    [0, 7, 4, 6],
    [0, 4, 5, 6],
  ];
  const epsilon = Math.min(cell.x, cell.y, cell.z) * 0.25;

  for (let zIndex = 0; zIndex < stepCounts.z; zIndex += 1) {
    for (let yIndex = 0; yIndex < stepCounts.y; yIndex += 1) {
      for (let xIndex = 0; xIndex < stepCounts.x; xIndex += 1) {
        const cubeCorners = cornerOffsets.map(([dx, dy, dz]) =>
          getStlCorner(field, dimensions, xIndex + dx, yIndex + dy, zIndex + dz),
        );
        const insideCount = cubeCorners.filter((corner) => corner.value >= 0).length;
        if (insideCount === 0 || insideCount === 8) {
          continue;
        }
        tetrahedra.forEach((tetrahedron) => {
          pushMarchingTetraTriangles(
            triangles,
            tetrahedron.map((cornerIndex) => cubeCorners[cornerIndex]),
            faceShapesByFace,
            dimensions,
            epsilon,
          );
        });
      }
    }
  }

  return triangles;
}

function buildStlText(documentData, dimensions, resolutionFactor = 1) {
  if (!dimensions) {
    return '';
  }
  const name = getOutputBaseName(documentData);
  const triangles = buildMarchingStlTriangles(documentData.shapes, dimensions, resolutionFactor, STL_MESH_OPTIONS);
  const lines = [`solid ${name}`];
  triangles.forEach(({ normal, vertices }) => {
    lines.push(`  facet normal ${formatStlNumber(normal.x)} ${formatStlNumber(normal.y)} ${formatStlNumber(normal.z)}`);
    lines.push('    outer loop');
    vertices.forEach((vertex) => {
      lines.push(`      vertex ${formatStlNumber(vertex.x)} ${formatStlNumber(vertex.y)} ${formatStlNumber(vertex.z)}`);
    });
    lines.push('    endloop');
    lines.push('  endfacet');
  });
  lines.push(`endsolid ${name}`);
  return lines.join('\n');
}


export { getFaceBounds, getAllFaceBounds, getFitTargetsForFace, getFaceConstraint, createEmptyConstraint, getProjectedConstraint, applyProjectedAxisConstraint, getLockConstraintForBounds, normalizeConstraint, getDocumentFaceConstraint, getLockedFaceConstraint, getAllDisplayConstraints, getAllLockedConstraints, hasAreaConstraint, areBoundsWithinConstraint, areLockedFaceBoundsValid, canLockFace, getConstraintSourceFaces, getAreaLockDiagnostic, formatRange, clampValue, constrainShapeToConstraint, constrainShape, constrainEditedShape, applyAreaLocks, getShapeControlLimits, getLockedRangeForDimension, getLockedPreviewDimensions, getRangeFromBounds, intersectDimensionRanges, getPreviewDimensionsFromFaceBounds, getDocumentPreviewDimensions, getAutomaticExportPreparation, pointInShape, pointInFaceSolid, getShapeSignedDistance, getFaceSignedDistance, isVoxelSolid, getVoxelKey, getVoxelCorners, buildSolidPreviewFaces, centeredCoordinate, getShapePlanRing, getShapeMultiPolygon, ringsEqualPoint, normalizePlanRing, FACE_BOOLEAN_POLYGON_CACHE_MAX, FACE_BOOLEAN_POLYGON_CACHE, getFaceBooleanPolygons, getBooleanPolygonBounds, isPointOnSegment, pointInPlanRing, pointInFacePolygons, collectPlanCoordinates, getAxisStops, normalizeMultiPolygon, normalizeIntervals, subtractIntervals, intersectIntervalSets, clampIntervalsToDimension, getRingLineIntervals, getLineIntervalsForPolygons, getIntervalRectangles, intersectPolygonsWithIntervals, differencePolygons, getSectionSample, getExtrudedSurfacePoint, getExtrusionIntervals, getConstrainedWallClass, buildConstrainedRingWalls, getZSectionPolygons, getYSectionPolygons, getXSectionPolygons, mapSectionPolygonToSurface, buildSectionSurfaces, buildSurfacePreviewFaces, subtractPoint, crossProduct, dotProduct, normalizeVector, getRingNormal, getProjectionAxes, getTriangleNormal, triangulateSurface, formatStlNumber, getOutputBaseName, STL_MESH_OPTIONS, getMeshBaseCellSize, getStlSpanStepCounts, getMeshResolutionMax, getStlVoxelGrid, getGridPointIndex, createStlAxisValues, createFaceDistanceGrid, getCenteredStlPoint, getFaceShapesByFace, getSolidSignedDistance, createStlField, getStlCorner, interpolateStlCorner, pushOrientedStlTriangle, pushMarchingTetraTriangles, buildMarchingStlTriangles, buildStlText };
