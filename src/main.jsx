import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import earcut from 'earcut';
import polygonClipping from 'polygon-clipping';
import {
  AI_MODEL_JSON_PROMPT,
  MODEL_SCHEMA_VERSION,
  parseModelJson,
  readModelJsonFile,
  serializeModelJson,
  validateAndMigrateModelDocument,
} from './model-json.js';
import { parseUrlAutomationRequest } from './url-automation.js';
import {
  createLockedDocumentFromBounds,
  diagnoseProjectionConsistency,
  getProjectionReadiness,
  projectionRangesMatch,
} from './projection-consistency.js';
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
} from './gear-geometry.js';
import {
  RACK_HEIGHT_MAX,
  RACK_TEETH_MAX,
  RACK_TEETH_MIN,
  getRackGearDimensions,
  getRackGearOutlineRing,
  getRackGearSignedDistance,
  pointInRackGear,
} from './rack-gear-geometry.js';
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
} from './internal-gear-geometry.js';
import {
  ceilToModelPrecision,
  createDiscreteSliderScale,
  floorToModelPrecision,
  normalizeModelPrecision,
  normalizeShapePrecision,
  roundToModelPrecision,
} from './numeric-precision.js';
import './style.css';

const STORAGE_KEY = 'oshidasumaho-cad-document-v1';
const SAVED_PARTS_KEY = 'oshidasumaho-cad-saved-parts-v1';
const ASSEMBLY_STORAGE_KEY = 'oshidasumaho-cad-assembly-v1';
const RECEIVER_TOKEN_KEY = 'oshidasumaho-cad-receiver-token-v1';
const APP_VERSION = 'proto-2026-06-02-18';
const SOLID_PREVIEW_STEPS = 18;
const CIRCLE_MESH_SEGMENTS = 64;
const STL_VOXEL_CELL_SIZE = 0.5;
const STL_VOXEL_MAX_AXIS_STEPS = 180;
const STL_VOXEL_MAX_CELLS = 12_000_000;
const STL_RESOLUTION_MAX = 20;
const SECTION_SAMPLE_EPSILON = 0.001;
const DEFAULT_ROTATION = { x: 24, y: -34, z: 0 };
const FACE_VIEW_ROTATIONS = {
  top: { x: 90, y: 0, z: 0 },
  front: { x: 0, y: 0, z: 0 },
  right: { x: 0, y: 0, z: -90 },
  left: { x: 0, y: 0, z: 90 },
  back: { x: 0, y: 0, z: 180 },
  bottom: { x: -90, y: 0, z: 0 },
};
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

const initialDocument = {
  schemaVersion: MODEL_SCHEMA_VERSION,
  extrude: 12,
  activeFace: 'top',
  areaLocks: DEFAULT_AREA_LOCKS,
  areaLockConstraints: DEFAULT_AREA_LOCK_CONSTRAINTS,
  viewMode: 'faces',
  rotation: DEFAULT_ROTATION,
  transparent3D: true,
  show3DGrid: false,
  show3DEdges: true,
  showAllDimensions: false,
  shapes: [
    { id: 1, type: 'rect', x: 10, y: 10, w: 70, h: 42, mode: 'add', face: 'top' },
    { id: 2, type: 'circle', x: 42, y: 31, r: 9, mode: 'cut', face: 'top' },
  ],
};

const ASSEMBLY_COLORS = [
  '#5b8def',
  '#f59e0b',
  '#10b981',
  '#ef4444',
  '#8b5cf6',
  '#06b6d4',
  '#f97316',
  '#64748b',
];

const initialAssemblyDocument = {
  viewRotation: DEFAULT_ROTATION,
  activeFace: 'top',
  instances: [],
};

function normalizeFace(face) {
  if (face === 'left') {
    return 'front';
  }
  return FACE_ORDER.includes(face) ? face : 'top';
}

function normalizeDocument(document) {
  document = normalizeModelPrecision(document);
  const activeFace = normalizeFace(document?.activeFace);
  const viewMode = document?.viewMode === '3d' ? '3d' : 'faces';
  const rotation = normalizeRotation(document?.rotation);
  const transparent3D = document?.transparent3D !== false;
  const show3DGrid = Boolean(document?.show3DGrid);
  const show3DEdges = document?.show3DEdges !== false;
  const showAllDimensions = Boolean(document?.showAllDimensions);
  const areaLocks = FACE_ORDER.reduce((locks, face) => ({
    ...locks,
    [face]: Boolean(document?.areaLocks?.[face]),
  }), DEFAULT_AREA_LOCKS);
  const areaLockConstraints = FACE_ORDER.reduce((constraints, face) => ({
    ...constraints,
    [face]: normalizeConstraint(document?.areaLockConstraints?.[face]),
  }), DEFAULT_AREA_LOCK_CONSTRAINTS);
  const shapes = Array.isArray(document?.shapes)
    ? document.shapes.map((shape) => ({
        ...shape,
        face: normalizeFace(shape.face ?? activeFace),
        showDimensions: Boolean(shape.showDimensions),
      }))
    : initialDocument.shapes;

  return {
    ...initialDocument,
    ...document,
    activeFace,
    areaLocks,
    areaLockConstraints,
    viewMode,
    rotation,
    transparent3D,
    show3DGrid,
    show3DEdges,
    showAllDimensions,
    shapes,
  };
}

function snapRightAngle(value) {
  return clampValue(Math.round((Number(value) || 0) / 90) * 90, -180, 180);
}

function normalizeAssemblyRotation(rotation) {
  return {
    x: snapRightAngle(rotation?.x),
    y: snapRightAngle(rotation?.y),
    z: snapRightAngle(rotation?.z),
  };
}

function normalizeAssemblyPosition(position) {
  return {
    x: roundToModelPrecision(clampValue(Number(position?.x ?? 0), -120, 120)),
    y: roundToModelPrecision(clampValue(Number(position?.y ?? 0), -120, 120)),
    z: roundToModelPrecision(clampValue(Number(position?.z ?? 0), -120, 120)),
  };
}

function normalizeAssemblyDocument(document) {
  const instances = Array.isArray(document?.instances)
    ? document.instances
        .filter((instance) => instance?.document)
        .map((instance, index) => ({
          id: instance.id || `assembly-part-${Date.now()}-${index}`,
          sourcePartId: instance.sourcePartId || '',
          name: instance.name || instance.document?.partName || `部品 ${index + 1}`,
          color: instance.color || ASSEMBLY_COLORS[index % ASSEMBLY_COLORS.length],
          position: normalizeAssemblyPosition(instance.position),
          rotation: normalizeAssemblyRotation(instance.rotation),
          document: normalizeDocument(instance.document),
        }))
    : [];

  return {
    ...initialAssemblyDocument,
    ...document,
    activeFace: normalizeFace(document?.activeFace),
    viewRotation: normalizeRotation(document?.viewRotation),
    instances,
  };
}

function normalizeRotation(rotation) {
  return {
    x: clampValue(Number(rotation?.x ?? DEFAULT_ROTATION.x), -180, 180),
    y: clampValue(Number(rotation?.y ?? DEFAULT_ROTATION.y), -180, 180),
    z: clampValue(Number(rotation?.z ?? DEFAULT_ROTATION.z), -180, 180),
  };
}

function loadDocument() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved
      ? normalizeDocument(validateAndMigrateModelDocument(JSON.parse(saved)))
      : normalizeDocument(initialDocument);
  } catch {
    return normalizeDocument(initialDocument);
  }
}

function loadAssemblyDocument() {
  try {
    const saved = localStorage.getItem(ASSEMBLY_STORAGE_KEY);
    return saved ? normalizeAssemblyDocument(JSON.parse(saved)) : normalizeAssemblyDocument(initialAssemblyDocument);
  } catch {
    return normalizeAssemblyDocument(initialAssemblyDocument);
  }
}

function loadSavedParts() {
  try {
    const saved = JSON.parse(localStorage.getItem(SAVED_PARTS_KEY) || '[]');
    if (!Array.isArray(saved)) {
      return [];
    }
    return saved
      .filter((item) => item?.id && item?.name && item?.document)
      .map((item) => ({
        ...item,
        document: normalizeDocument(item.document),
      }));
  } catch {
    return [];
  }
}

function storeSavedParts(parts) {
  localStorage.setItem(SAVED_PARTS_KEY, JSON.stringify(parts));
}

function getNextId(shapes) {
  return Math.max(0, ...shapes.map((shape) => shape.id)) + 1;
}

function getShapeLabel(shape) {
  const typeLabel = shape.type === 'rect'
    ? 'Rect'
    : shape.type === 'circle'
      ? 'Circle'
      : shape.type === 'gear'
        ? 'Gear'
        : shape.type === 'rack'
          ? 'Rack'
          : 'Internal Gear';
  return `${typeLabel} ${shape.id}`;
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
    const teeth = clampValue(Math.round(shape.teeth), RACK_TEETH_MIN, RACK_TEETH_MAX);
    const availableWidth = constraint.maxX - constraint.minX;
    const availableHeight = constraint.maxY - constraint.minY;
    const maximumModule = Math.min(
      GEAR_MODULE_MAX,
      availableWidth / (Math.PI * teeth),
      availableHeight / 2.25,
    );
    const moduleValue = clampValue(shape.module, GEAR_MODULE_MIN, Math.max(GEAR_MODULE_MIN, maximumModule));
    const provisional = getRackGearDimensions({ ...shape, teeth, module: moduleValue });
    const height = clampValue(
      Math.round(shape.height),
      provisional.minimumHeight,
      Math.max(provisional.minimumHeight, Math.floor(availableHeight)),
    );
    const constrainedRack = { ...shape, teeth, module: moduleValue, height };
    const { width } = getRackGearDimensions(constrainedRack);
    const constrainedWidth = roundToModelPrecision(width);
    return {
      ...constrainedRack,
      x: clampValue(shape.x, constraint.minX, constraint.maxX - constrainedWidth),
      y: clampValue(shape.y, constraint.minY, constraint.maxY - height),
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
    const constrainedWidth = roundToModelPrecision(dimensions.width);
    const availableWidth = Math.max(0, fullConstraint.maxX - shape.x);
    const availableHeight = Math.max(0, fullConstraint.maxY - shape.y);
    return {
      x: { min: fullConstraint.minX, max: Math.max(fullConstraint.minX, fullConstraint.maxX - constrainedWidth) },
      y: { min: fullConstraint.minY, max: Math.max(fullConstraint.minY, fullConstraint.maxY - dimensions.height) },
      module: {
        min: GEAR_MODULE_MIN,
        max: Math.max(
          GEAR_MODULE_MIN,
          roundToModelPrecision(
            Math.min(GEAR_MODULE_MAX, availableWidth / (Math.PI * shape.teeth), shape.height / 2.25),
          ),
        ),
      },
      teeth: {
        min: RACK_TEETH_MIN,
        max: Math.max(
          RACK_TEETH_MIN,
          Math.min(RACK_TEETH_MAX, Math.floor(availableWidth / (Math.PI * shape.module))),
        ),
      },
      height: {
        min: dimensions.minimumHeight,
        max: Math.max(dimensions.minimumHeight, Math.min(RACK_HEIGHT_MAX, Math.floor(availableHeight))),
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
  const normalizedDocument = normalizeDocument(documentData);
  return getLockedPreviewDimensions(normalizedDocument) ?? getPreviewDimensionsFromFaceBounds(normalizedDocument);
}

function getAutomaticExportPreparation(documentData) {
  const normalizedDocument = normalizeDocument(documentData);
  const faceBounds = getAllFaceBounds(normalizedDocument.shapes);
  const diagnostic = diagnoseProjectionConsistency(faceBounds);
  if (!diagnostic.valid) {
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

  const lockedDocument = normalizeDocument(createLockedDocumentFromBounds(normalizedDocument, faceBounds));
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

function getFaceBooleanPolygons(faceShapes, circleSegments = CIRCLE_MESH_SEGMENTS) {
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

  return normalizeMultiPolygon(solid);
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

let replicadReadyPromise = null;

async function ensureReplicadReady() {
  if (!replicadReadyPromise) {
    replicadReadyPromise = Promise.all([
      import('replicad-opencascadejs/src/replicad_single.js'),
      import('replicad-opencascadejs/src/replicad_single.wasm?url'),
      import('replicad'),
    ]).then(async ([opencascadeModule, opencascadeWasmModule, replicad]) => {
      const opencascade = opencascadeModule.default;
      const opencascadeWasm = opencascadeWasmModule.default;
      const oc = await opencascade({
        locateFile: (path) => (path.endsWith('.wasm') ? opencascadeWasm : path),
      });
      replicad.setOC(oc);
      return replicad;
    });
  }
  return replicadReadyPromise;
}

function getReplicadPlaneConfig(shape, face, dimensions) {
  const rackDimensions = shape.type === 'rack' ? getRackGearDimensions(shape) : null;
  const centerU = shape.type === 'rect'
    ? shape.x + shape.w / 2
    : shape.type === 'rack'
      ? shape.x + rackDimensions.width / 2
      : shape.x;
  const centerV = shape.type === 'rect'
    ? shape.y + shape.h / 2
    : shape.type === 'rack'
      ? shape.y + rackDimensions.height / 2
      : shape.y;

  if (face === 'top') {
    return {
      plane: 'XY',
      origin: [
        centeredCoordinate(centerU, dimensions.width),
        centeredCoordinate(centerV, dimensions.depth),
        -dimensions.height.size / 2,
      ],
      distance: dimensions.height.size,
    };
  }
  if (face === 'front') {
    return {
      plane: 'XZ',
      origin: [
        centeredCoordinate(centerU, dimensions.width),
        dimensions.depth.size / 2,
        centeredCoordinate(centerV, dimensions.height),
      ],
      distance: dimensions.depth.size,
    };
  }
  return {
    plane: 'YZ',
    origin: [
      -dimensions.width.size / 2,
      centeredCoordinate(centerU, dimensions.depth),
      centeredCoordinate(centerV, dimensions.height),
    ],
    distance: dimensions.width.size,
  };
}

function createReplicadPrism(replicad, shape, face, dimensions) {
  const planeConfig = getReplicadPlaneConfig(shape, face, dimensions);
  if (shape.type === 'gear') {
    const localGear = { ...shape, x: 0, y: 0 };
    const ring = getGearOutlineRing(localGear);
    const pen = replicad.draw(ring[0]);
    ring.slice(1).forEach((point) => pen.lineTo(point));
    let drawing = pen.close();
    const { boreRadius } = getGearRadii(localGear);
    if (boreRadius > 0) {
      drawing = drawing.cut(replicad.drawCircle(boreRadius));
    }
    return drawing
      .sketchOnPlane(planeConfig.plane, planeConfig.origin)
      .extrude(planeConfig.distance);
  }
  if (shape.type === 'internalGear') {
    const localGear = { ...shape, x: 0, y: 0 };
    const innerRing = getInternalGearInnerRing(localGear);
    const innerPen = replicad.draw(innerRing[0]);
    innerRing.slice(1).forEach((point) => innerPen.lineTo(point));
    const { outerRadius } = getInternalGearRadii(localGear);
    return replicad.drawCircle(outerRadius)
      .cut(innerPen.close())
      .sketchOnPlane(planeConfig.plane, planeConfig.origin)
      .extrude(planeConfig.distance);
  }
  if (shape.type === 'rack') {
    const rackDimensions = getRackGearDimensions(shape);
    const localRack = {
      ...shape,
      x: -rackDimensions.width / 2,
      y: -rackDimensions.height / 2,
    };
    const ring = getRackGearOutlineRing(localRack);
    const pen = replicad.draw(ring[0]);
    ring.slice(1).forEach((point) => pen.lineTo(point));
    return pen.close()
      .sketchOnPlane(planeConfig.plane, planeConfig.origin)
      .extrude(planeConfig.distance);
  }
  const sketch = shape.type === 'circle'
    ? replicad.sketchCircle(shape.r, planeConfig)
    : replicad.sketchRectangle(shape.w, shape.h, planeConfig);
  return sketch.extrude(planeConfig.distance);
}

function buildReplicadFaceSolid(replicad, shapes, face, dimensions) {
  return shapes
    .filter((shape) => normalizeFace(shape.face) === face)
    .reduce((solid, shape) => {
      const prism = createReplicadPrism(replicad, shape, face, dimensions);
      if (shape.mode === 'cut') {
        return solid ? solid.cut(prism) : solid;
      }
      return solid ? solid.fuse(prism) : prism;
    }, null);
}

function buildReplicadSolid(replicad, documentData, dimensions) {
  const solids = FACE_ORDER.map((face) => buildReplicadFaceSolid(replicad, documentData.shapes, face, dimensions));
  if (solids.some((solid) => !solid)) {
    throw new Error('3面すべてに有効なadd図形が必要です。');
  }
  return solids.slice(1).reduce((solid, nextSolid) => solid.intersect(nextSolid), solids[0]);
}

async function buildReplicadStepBlob(documentData, dimensions) {
  if (!dimensions) {
    return null;
  }

  const replicad = await ensureReplicadReady();
  const solid = buildReplicadSolid(replicad, documentData, dimensions);
  return replicad.exportSTEP(
    [{
      shape: solid,
      name: getOutputBaseName(documentData),
      color: '#7ea1e8',
      alpha: 1,
    }],
    { unit: 'MM', modelUnit: 'MM' },
  );
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

function App() {
  const [appMode, setAppMode] = useState('part');
  const [document, setDocument] = useState(loadDocument);
  const [assembly, setAssembly] = useState(loadAssemblyDocument);
  const [selectedId, setSelectedId] = useState(document.shapes[0]?.id ?? null);
  const [selectedAssemblyId, setSelectedAssemblyId] = useState(null);
  const [assemblyViewport, setAssemblyViewport] = useState('3d');
  const [fullAssemblyPreview, setFullAssemblyPreview] = useState(null);
  const [preview3DSelected, setPreview3DSelected] = useState(false);
  const [fullPreviewFace, setFullPreviewFace] = useState(null);
  const [outputOpen, setOutputOpen] = useState(false);
  const [outputFormat, setOutputFormat] = useState('json');
  const [previewMenuOpen, setPreviewMenuOpen] = useState(false);
  const [savedParts, setSavedParts] = useState(loadSavedParts);
  const [saveName, setSaveName] = useState(document.partName ?? '');
  const [loadPartId, setLoadPartId] = useState('');
  const [stlSaving, setStlSaving] = useState(false);
  const [stepSaving, setStepSaving] = useState(false);
  const [stlResolution, setStlResolution] = useState(1);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [localPrintInfo, setLocalPrintInfo] = useState(null);
  const [localPrintOpen, setLocalPrintOpen] = useState(false);
  const [localPrintSource, setLocalPrintSource] = useState('current');
  const [localPrintFile, setLocalPrintFile] = useState(null);
  const [localPrintToken, setLocalPrintToken] = useState(() => localStorage.getItem(RECEIVER_TOKEN_KEY) || '');
  const [localPrintStatus, setLocalPrintStatus] = useState(null);
  const [localPrintSubmitting, setLocalPrintSubmitting] = useState(false);
  const [localPrintLayerHeight, setLocalPrintLayerHeight] = useState('0.20');
  const [localPrintSupport, setLocalPrintSupport] = useState(false);
  const [jsonImportStatus, setJsonImportStatus] = useState(null);
  const [areaLockFeedback, setAreaLockFeedback] = useState(null);
  const [urlAutomationStatus, setUrlAutomationStatus] = useState(null);
  const [urlAutomationMode, setUrlAutomationMode] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('mode')?.trim().toLowerCase() === 'automation'
      || params.get('ui')?.trim().toLowerCase() === 'none';
  });
  const [urlDownloadArtifact, setUrlDownloadArtifact] = useState(null);
  const urlAutomationStartedRef = useRef(false);
  const controlPanelRef = useRef(null);
  const editorRefs = useRef(new Map());
  const assemblyRefs = useRef(new Map());

  const selectedShape = document.shapes.find((shape) => shape.id === selectedId);
  const activeFace = normalizeFace(document.activeFace);
  const activeShapes = document.shapes.filter((shape) => normalizeFace(shape.face) === activeFace);
  const faceBounds = useMemo(() => getAllFaceBounds(document.shapes), [document.shapes]);
  const lockedConstraints = useMemo(() => getAllLockedConstraints(document), [document]);
  const areaLockDiagnostics = useMemo(
    () => Object.fromEntries(FACE_ORDER.map((face) => [face, getAreaLockDiagnostic(document, face, faceBounds)])),
    [document, faceBounds],
  );
  const areaLockAvailability = useMemo(
    () => Object.fromEntries(FACE_ORDER.map((face) => [face, areaLockDiagnostics[face].canLock])),
    [areaLockDiagnostics],
  );
  const previewDimensions = useMemo(() => getLockedPreviewDimensions(document), [document]);
  const stlResolutionMax = useMemo(() => getMeshResolutionMax(previewDimensions, STL_MESH_OPTIONS), [previewDimensions]);
  const showing3DControls = !outputOpen && Boolean((document.viewMode === '3d' || preview3DSelected) && previewDimensions);
  const showingFaceControls = !showing3DControls && !outputOpen;
  const jsonText = useMemo(() => serializeModelJson(document), [document]);
  const selectedAssemblyInstance = assembly.instances.find((instance) => instance.id === selectedAssemblyId);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(document));
  }, [document]);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/health', { signal: controller.signal, cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((info) => {
        if (info?.localPrintUi === true) setLocalPrintInfo(info);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (urlAutomationStartedRef.current) {
      return;
    }
    urlAutomationStartedRef.current = true;
    void runUrlAutomation();
  }, []);

  useEffect(() => {
    localStorage.setItem(ASSEMBLY_STORAGE_KEY, JSON.stringify(assembly));
  }, [assembly]);

  useEffect(() => {
    setSaveName(document.partName ?? '');
  }, [document.partName]);

  useEffect(() => {
    setStlResolution((current) => Math.min(current, stlResolutionMax));
  }, [stlResolutionMax]);

  useEffect(() => {
    if (appMode !== 'part') {
      return;
    }
    const editor = editorRefs.current.get(selectedId);
    const panel = controlPanelRef.current;
    if (!selectedId && panel) {
      panel.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    if (editor && panel) {
      const panelRect = panel.getBoundingClientRect();
      const editorRect = editor.getBoundingClientRect();
      const targetTop = panel.scrollTop + editorRect.top - panelRect.top - 18;
      panel.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
    }
  }, [selectedId, activeFace]);

  useEffect(() => {
    if (appMode !== 'assembly') {
      return;
    }
    const editor = assemblyRefs.current.get(selectedAssemblyId);
    const panel = controlPanelRef.current;
    if (!selectedAssemblyId && panel) {
      panel.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    if (editor && panel) {
      const panelRect = panel.getBoundingClientRect();
      const editorRect = editor.getBoundingClientRect();
      const targetTop = panel.scrollTop + editorRect.top - panelRect.top - 18;
      panel.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
    }
  }, [selectedAssemblyId, assembly.activeFace, appMode]);

  function updateDocument(patch) {
    setDocument((current) => ({ ...current, ...patch }));
  }

  function updateRotation(axis, value) {
    setDocument((current) => ({
      ...current,
      rotation: normalizeRotation({
        ...current.rotation,
        [axis]: value,
      }),
    }));
  }

  function setRotation(rotation) {
    setDocument((current) => ({
      ...current,
      rotation: normalizeRotation(rotation),
    }));
  }

  function setTransparent3D(transparent3D) {
    setDocument((current) => ({
      ...current,
      transparent3D,
    }));
  }

  function setShow3DGrid(show3DGrid) {
    setDocument((current) => ({
      ...current,
      show3DGrid,
    }));
  }

  function setShow3DEdges(show3DEdges) {
    setDocument((current) => ({
      ...current,
      show3DEdges,
    }));
  }

  function updateShape(id, patch) {
    setPreview3DSelected(false);
    setOutputOpen(false);
    setAreaLockFeedback(null);
    setDocument((current) => {
      const nextDocument = applyAreaLocks({
        ...current,
        activeFace: patch.face ? normalizeFace(patch.face) : current.activeFace,
        shapes: current.shapes.map((shape) => {
          if (shape.id !== id) {
            return shape;
          }
          const nextShape = { ...shape, ...patch };
          const face = normalizeFace(nextShape.face);
          const constraint = getLockedFaceConstraint(current, face);
          if (nextShape.type === 'gear' || nextShape.type === 'rack' || nextShape.type === 'internalGear') {
            return constrainShape(
              nextShape,
              hasAreaConstraint(constraint)
                ? constraint
                : { minX: 0, maxX: 120, minY: 0, maxY: 120 },
            );
          }
          if (nextShape.mode === 'cut' || !hasAreaConstraint(constraint)) {
            return normalizeShapePrecision(nextShape);
          }
          return constrainShape(nextShape, constraint);
        }),
      });
      return areLockedFaceBoundsValid(nextDocument) ? nextDocument : current;
    });
  }

  function toggleAllDimensions() {
    setDocument((current) => ({
      ...current,
      showAllDimensions: !current.showAllDimensions,
    }));
  }

  function addShape(type) {
    setPreview3DSelected(false);
    setOutputOpen(false);
    setAreaLockFeedback(null);
    setDocument((current) => {
      const id = getNextId(current.shapes);
      const face = normalizeFace(current.activeFace);
      const shapeBase =
        type === 'rect'
          ? { id, type: 'rect', x: 18, y: 16, w: 42, h: 28, mode: 'add', face }
          : type === 'circle'
            ? { id, type: 'circle', x: 44, y: 32, r: 3, mode: 'cut', face }
            : type === 'gear'
              ? { id, type: 'gear', x: 45, y: 45, module: 1, teeth: 24, bore: 6, mode: 'add', face }
              : type === 'rack'
                ? { id, type: 'rack', x: 20, y: 45, module: 1, teeth: 20, height: 10, mode: 'add', face }
                : { id, type: 'internalGear', x: 60, y: 60, module: 1, teeth: 50, outerDiameter: 68, mode: 'add', face };
      const constraint = getLockedFaceConstraint(current, face);
      const shape = shapeBase.mode !== 'cut' && hasAreaConstraint(constraint)
        ? constrainShape(shapeBase, constraint)
        : shapeBase;
      setSelectedId(id);
      const nextDocument = applyAreaLocks({ ...current, shapes: [...current.shapes, shape] });
      return areLockedFaceBoundsValid(nextDocument) ? nextDocument : current;
    });
  }

  function removeShape(id) {
    setPreview3DSelected(false);
    setOutputOpen(false);
    setAreaLockFeedback(null);
    setDocument((current) => {
      const nextShapes = current.shapes.filter((shape) => shape.id !== id);
      if (selectedId === id) {
        setSelectedId(nextShapes[0]?.id ?? null);
      }
      const nextDocument = applyAreaLocks({ ...current, shapes: nextShapes });
      return areLockedFaceBoundsValid(nextDocument) ? nextDocument : current;
    });
  }

  function selectShape(id) {
    setPreview3DSelected(false);
    setOutputOpen(false);
    if (!id) {
      setSelectedId(null);
      return;
    }

    const shape = document.shapes.find((item) => item.id === id);
    if (shape) {
      updateDocument({ activeFace: normalizeFace(shape.face) });
    }
    setSelectedId(id);
  }

  function moveShape(id, direction) {
    setAreaLockFeedback(null);
    setDocument((current) => {
      const shape = current.shapes.find((item) => item.id === id);
      if (!shape) {
        return current;
      }

      const faceShapes = current.shapes.filter((item) => normalizeFace(item.face) === normalizeFace(shape.face));
      const faceIndex = faceShapes.findIndex((item) => item.id === id);
      const nextFaceShape = faceShapes[faceIndex + direction];
      if (!nextFaceShape) {
        return current;
      }

      const index = current.shapes.findIndex((item) => item.id === id);
      const nextIndex = current.shapes.findIndex((item) => item.id === nextFaceShape.id);
      const shapes = [...current.shapes];
      [shapes[index], shapes[nextIndex]] = [shapes[nextIndex], shapes[index]];
      const nextDocument = { ...current, shapes };
      return areLockedFaceBoundsValid(nextDocument) ? nextDocument : current;
    });
  }

  function toggleAreaLock(face) {
    setPreview3DSelected(false);
    setOutputOpen(false);
    const normalizedFace = normalizeFace(face);
    setDocument((current) => {
      const currentLocks = { ...DEFAULT_AREA_LOCKS, ...current.areaLocks };
      const currentConstraints = {
        ...DEFAULT_AREA_LOCK_CONSTRAINTS,
        ...current.areaLockConstraints,
      };
      const nextLockValue = !currentLocks[normalizedFace];
      const nextConstraint = getLockConstraintForBounds(getFaceBounds(current.shapes, normalizedFace));
      const diagnostic = getAreaLockDiagnostic(current, normalizedFace);
      if (nextLockValue && !diagnostic.canLock) {
        setAreaLockFeedback(diagnostic);
        return current;
      }
      setAreaLockFeedback(null);

      const nextDocument = {
        ...current,
        areaLocks: {
          ...currentLocks,
          [normalizedFace]: nextLockValue,
        },
        areaLockConstraints: {
          ...currentConstraints,
          [normalizedFace]: nextLockValue ? nextConstraint : null,
        },
      };
      return areLockedFaceBoundsValid(nextDocument) ? nextDocument : current;
    });
  }

  function resetDocument() {
    setDocument(initialDocument);
    setSelectedId(initialDocument.shapes[0].id);
    setPreview3DSelected(false);
    setFullPreviewFace(null);
    setOutputOpen(false);
    setPreviewMenuOpen(false);
    setResetConfirmOpen(false);
    setAreaLockFeedback(null);
  }

  function openSavePanel(format = 'json') {
    setOutputOpen(true);
    setOutputFormat(format);
    setSelectedId(null);
    setPreview3DSelected(false);
    setPreviewMenuOpen(false);
  }

  function openHelpPanel() {
    openSavePanel('help');
  }

  function openLoadPanel() {
    openSavePanel('load');
    setLoadPartId((current) => current || savedParts[0]?.id || '');
    setJsonImportStatus(null);
  }

  function requestScreenReset() {
    setResetConfirmOpen(true);
    setPreviewMenuOpen(false);
  }

  function updatePartName(name) {
    setSaveName(name);
    setDocument((current) => ({ ...current, partName: name }));
  }

  function savePartToWeb() {
    const name = saveName.trim();
    if (!name) {
      return;
    }
    const savedAt = new Date().toISOString();
    const nextDocument = normalizeDocument({ ...document, partName: name });
    const existing = savedParts.find((part) => part.name === name);
    const nextPart = {
      id: existing?.id ?? `part-${Date.now()}`,
      name,
      savedAt,
      document: nextDocument,
    };
    const nextSavedParts = [
      ...savedParts.filter((part) => part.id !== nextPart.id && part.name !== name),
      nextPart,
    ].sort((a, b) => a.name.localeCompare(b.name, 'ja'));
    setSavedParts(nextSavedParts);
    storeSavedParts(nextSavedParts);
    setDocument(nextDocument);
    setLoadPartId(nextPart.id);
  }

  function loadPart() {
    const part = savedParts.find((item) => item.id === loadPartId);
    if (!part) {
      return;
    }
    const nextDocument = normalizeDocument(part.document);
    setDocument(nextDocument);
    setSelectedId(nextDocument.shapes[0]?.id ?? null);
    setPreview3DSelected(false);
    setFullPreviewFace(null);
    setPreviewMenuOpen(false);
  }

  function restoreImportedDocument(importedDocument, sourceLabel) {
    const nextDocument = normalizeDocument(importedDocument);
    setDocument(nextDocument);
    setSelectedId(null);
    setPreview3DSelected(false);
    setFullPreviewFace(null);
    setAreaLockFeedback(null);
    setJsonImportStatus({
      type: 'success',
      message: `「${nextDocument.partName || sourceLabel}」を読み込みました。`,
    });
  }

  async function importJsonFile(file) {
    setJsonImportStatus({ type: 'loading', message: 'JSONを読み込んでいます...' });
    try {
      const importedDocument = await readModelJsonFile(file);
      restoreImportedDocument(importedDocument, file.name);
    } catch (error) {
      setJsonImportStatus({
        type: 'error',
        message: error instanceof Error ? error.message : 'JSONの読み込みに失敗しました。',
      });
    }
  }

  function importJsonText(text) {
    setJsonImportStatus(null);
    try {
      restoreImportedDocument(parseModelJson(text), '貼り付けJSON');
    } catch (error) {
      setJsonImportStatus({
        type: 'error',
        message: error instanceof Error ? error.message : 'JSONの読み込みに失敗しました。',
      });
    }
  }

  function deleteSavedPart() {
    if (!loadPartId) {
      return;
    }
    const nextSavedParts = savedParts.filter((part) => part.id !== loadPartId);
    setSavedParts(nextSavedParts);
    storeSavedParts(nextSavedParts);
    setLoadPartId(nextSavedParts[0]?.id ?? '');
  }

  function openAssemblyMode() {
    setAppMode('assembly');
    setPreviewMenuOpen(false);
    setAssemblyViewport('3d');
    setFullAssemblyPreview(null);
    setSelectedAssemblyId(null);
    setOutputOpen(false);
    setPreview3DSelected(false);
  }

  function openPartMode() {
    setAppMode('part');
    setPreviewMenuOpen(false);
    setAssemblyViewport('3d');
    setFullAssemblyPreview(null);
  }

  function addAssemblyInstance(partId) {
    const part = savedParts.find((item) => item.id === partId);
    if (!part) {
      return;
    }
    const documentSnapshot = normalizeDocument(part.document);
    const id = `assembly-${Date.now()}`;
    const instance = {
      id,
      sourcePartId: part.id,
      name: part.name,
      color: ASSEMBLY_COLORS[assembly.instances.length % ASSEMBLY_COLORS.length],
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      document: documentSnapshot,
    };
    setAssembly((current) => normalizeAssemblyDocument({
      ...current,
      instances: [...current.instances, instance],
    }));
    setSelectedAssemblyId(id);
    setAssemblyViewport('3d');
    setFullAssemblyPreview(null);
  }

  function updateAssemblyViewRotation(axis, value) {
    setAssembly((current) => ({
      ...current,
      viewRotation: normalizeRotation({
        ...current.viewRotation,
        [axis]: value,
      }),
    }));
  }

  function setAssemblyViewRotation(rotation) {
    setAssembly((current) => ({
      ...current,
      viewRotation: normalizeRotation(rotation),
    }));
    setAssemblyViewport('3d');
    setFullAssemblyPreview((current) => (current === '3d' ? '3d' : null));
  }

  function resetAssemblyViewRotation() {
    setAssembly((current) => ({
      ...current,
      viewRotation: DEFAULT_ROTATION,
    }));
    setAssemblyViewport('3d');
    setFullAssemblyPreview((current) => (current === '3d' ? '3d' : null));
  }

  function selectAssemblyViewport(viewport) {
    setAssemblyViewport(viewport);
    if (viewport !== '3d') {
      setAssembly((current) => ({
        ...current,
        activeFace: normalizeFace(viewport),
      }));
    }
  }

  function toggleFullAssemblyPreview(viewport) {
    const nextViewport = viewport === '3d' ? '3d' : normalizeFace(viewport);
    selectAssemblyViewport(nextViewport);
    setFullAssemblyPreview((current) => (current === nextViewport ? null : nextViewport));
  }

  function selectAssemblyInstance(id, viewport = assemblyViewport) {
    setSelectedAssemblyId(id);
    selectAssemblyViewport(viewport);
  }

  function updateAssemblyInstance(id, patch) {
    setAssembly((current) => normalizeAssemblyDocument({
      ...current,
      instances: current.instances.map((instance) => (
        instance.id === id
          ? {
              ...instance,
              ...patch,
              position: patch.position ? normalizeAssemblyPosition(patch.position) : instance.position,
              rotation: patch.rotation ? normalizeAssemblyRotation(patch.rotation) : instance.rotation,
            }
          : instance
      )),
    }));
  }

  function removeAssemblyInstance(id) {
    setAssembly((current) => ({
      ...current,
      instances: current.instances.filter((instance) => instance.id !== id),
    }));
    if (selectedAssemblyId === id) {
      setSelectedAssemblyId(null);
    }
  }

  function setActiveFace(face) {
    setPreview3DSelected(false);
    setOutputOpen(false);
    setAreaLockFeedback(null);
    updateDocument({ activeFace: normalizeFace(face) });
    setSelectedId(null);
  }

  function toggleFullPreview(face) {
    setPreview3DSelected(false);
    setOutputOpen(false);
    const normalizedFace = normalizeFace(face);
    updateDocument({ activeFace: normalizedFace });
    setSelectedId(null);
    setFullPreviewFace((current) => (current === normalizedFace ? null : normalizedFace));
  }

  function toggle3DPreview() {
    if (!previewDimensions) {
      return;
    }
    setDocument((current) => ({
      ...current,
      viewMode: current.viewMode === '3d' ? 'faces' : '3d',
    }));
    setFullPreviewFace(null);
    setSelectedId(null);
    setPreview3DSelected(true);
    setOutputOpen(false);
  }

  function select3DPreview() {
    if (!previewDimensions) {
      return;
    }
    setPreview3DSelected(true);
    setFullPreviewFace(null);
    setSelectedId(null);
    setOutputOpen(false);
  }

  async function copyTextOutput(text) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const textArea = window.document.createElement('textarea');
    textArea.value = text;
    window.document.body.appendChild(textArea);
    textArea.select();
    window.document.execCommand('copy');
    window.document.body.removeChild(textArea);
  }

  function saveTextOutput(text, extension, type) {
    const blob = new Blob([text], { type });
    saveBlobOutput(blob, extension);
  }

  function saveBlobOutput(blob, extension) {
    saveBlobOutputForDocument(blob, extension, document);
  }

  function saveBlobOutputForDocument(blob, extension, documentData) {
    const fileNameBase = getOutputBaseName(documentData);
    const url = URL.createObjectURL(blob);
    const anchor = window.document.createElement('a');
    anchor.href = url;
    anchor.download = `${fileNameBase}.${extension}`;
    anchor.style.display = 'none';
    window.document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function runUrlAutomation() {
    let request;
    const queryParams = new URLSearchParams(window.location.search);
    const explicitAutomationMode = queryParams.get('mode')?.trim().toLowerCase() === 'automation'
      || queryParams.get('ui')?.trim().toLowerCase() === 'none';
    setUrlAutomationMode(explicitAutomationMode);
    setUrlDownloadArtifact(null);
    try {
      request = parseUrlAutomationRequest(window.location.search);
      if (!request) {
        return;
      }
      setUrlAutomationMode(request.automationMode);
      const importedDocument = normalizeDocument(request.document);
      setDocument(importedDocument);
      setSelectedId(null);
      setPreview3DSelected(false);
      setFullPreviewFace(null);
      setAreaLockFeedback(null);
      console.log('[Oshida CAD URL] JSON loaded', {
        source: request.source,
        format: request.format,
        download: request.download,
        mode: request.automationMode ? 'automation' : 'normal',
      });

      if (!request.format) {
        setUrlAutomationStatus({
          type: 'success',
          message: 'URLからJSONを読み込みました。',
        });
        return;
      }

      setUrlAutomationStatus({
        type: 'loading',
        message: `${request.format.toUpperCase()}を生成しています...`,
      });
      const prepared = getAutomaticExportPreparation(importedDocument);
      setDocument(prepared.document);
      await new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));

      let artifact;
      if (request.format === 'stl') {
        const stlText = buildStlText(prepared.document, prepared.dimensions, 1);
        if (!stlText.includes('facet normal')) {
          throw new Error('STLメッシュに有効な三角形がありません。');
        }
        artifact = {
          blob: new Blob([stlText], { type: 'model/stl' }),
          extension: 'stl',
          document: prepared.document,
        };
      } else {
        const stepBlob = await buildReplicadStepBlob(prepared.document, prepared.dimensions);
        if (!stepBlob || stepBlob.size === 0) {
          throw new Error('STEPデータを生成できませんでした。');
        }
        artifact = {
          blob: stepBlob,
          extension: 'step',
          document: prepared.document,
        };
      }
      console.log('[Oshida CAD URL] Export generated', {
        format: artifact.extension,
        bytes: artifact.blob.size,
      });

      if (!request.automationMode) {
        setUrlDownloadArtifact(artifact);
      }
      if (request.download) {
        saveBlobOutputForDocument(artifact.blob, artifact.extension, artifact.document);
        console.log('[Oshida CAD URL] Automatic download requested', {
          format: artifact.extension,
          fileName: `${getOutputBaseName(artifact.document)}.${artifact.extension}`,
        });
      }
      setUrlAutomationStatus({
        type: 'success',
        message: request.automationMode
          ? `${request.format.toUpperCase()} ${request.download ? 'download requested' : 'generated'}`
          : request.download
            ? `${request.format.toUpperCase()}の自動保存を試行しました。開始されない場合は手動保存してください。`
            : `${request.format.toUpperCase()}を生成しました。`,
      });
    } catch (error) {
      console.error('[Oshida CAD URL] Automation failed', error);
      setUrlAutomationStatus({
        type: 'error',
        message: error instanceof Error ? error.message : 'URL自動出力に失敗しました。',
      });
    }
  }

  function saveUrlDownloadArtifact() {
    if (!urlDownloadArtifact) {
      return;
    }
    saveBlobOutputForDocument(
      urlDownloadArtifact.blob,
      urlDownloadArtifact.extension,
      urlDownloadArtifact.document,
    );
    console.log('[Oshida CAD URL] Manual download requested', {
      format: urlDownloadArtifact.extension,
    });
  }

  async function saveStlOutput() {
    if (!previewDimensions || stlSaving) {
      return;
    }

    setStlSaving(true);
    try {
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
      saveTextOutput(buildStlText(document, previewDimensions, stlResolution), 'stl', 'model/stl');
    } finally {
      setStlSaving(false);
    }
  }

  async function saveStepOutput() {
    if (!previewDimensions || stepSaving) {
      return;
    }

    setStepSaving(true);
    try {
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
      const stepBlob = await buildReplicadStepBlob(document, previewDimensions);
      if (stepBlob) {
        saveBlobOutput(stepBlob, 'step');
      }
    } catch (error) {
      window.alert(`STEP生成に失敗しました: ${error.message}`);
    } finally {
      setStepSaving(false);
    }
  }

  function openLocalPrintDialog() {
    setPreviewMenuOpen(false);
    setLocalPrintSource(previewDimensions ? 'current' : 'file');
    setLocalPrintFile(null);
    setLocalPrintStatus(null);
    setLocalPrintOpen(true);
  }

  async function submitLocalPrint() {
    if (localPrintSubmitting) return;
    setLocalPrintSubmitting(true);
    setLocalPrintStatus({ type: 'working', message: 'STLを送信し、印刷開始を待っています...' });

    try {
      let blob;
      let filename;
      if (localPrintSource === 'current') {
        if (!previewDimensions) throw new Error('現在のモデルはまだSTLを生成できません。');
        await new Promise((resolveFrame) => window.requestAnimationFrame(resolveFrame));
        const stlText = buildStlText(document, previewDimensions, stlResolution);
        if (!stlText.includes('facet normal')) throw new Error('STLに有効な三角形がありません。');
        blob = new Blob([stlText], { type: 'model/stl' });
        filename = `${getOutputBaseName(document)}.stl`;
      } else {
        if (!localPrintFile) throw new Error('STLファイルを選択してください。');
        blob = localPrintFile;
        filename = localPrintFile.name;
      }

      if (localPrintInfo?.tokenRequired && !localPrintToken.trim()) {
        throw new Error('Receiver tokenを入力してください。');
      }
      if (localPrintToken.trim()) localStorage.setItem(RECEIVER_TOKEN_KEY, localPrintToken.trim());

      const response = await fetch('/upload', {
        method: 'POST',
        headers: {
          'Content-Type': 'model/stl',
          'X-Filename': filename,
          'X-Layer-Height': localPrintLayerHeight,
          'X-Enable-Support': localPrintSupport ? '1' : '0',
          ...(localPrintToken.trim() ? { 'X-Receiver-Token': localPrintToken.trim() } : {}),
        },
        body: blob,
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `送信に失敗しました (${response.status})`);
      const pipelineStatus = result.pipeline?.status || 'completed';
      setLocalPrintStatus({
        type: 'success',
        message: `処理完了: ${pipelineStatus} / ${localPrintLayerHeight} mm / サポート${localPrintSupport ? 'あり' : 'なし'}`,
      });
    } catch (error) {
      setLocalPrintStatus({ type: 'error', message: error instanceof Error ? error.message : '送信に失敗しました。' });
    } finally {
      setLocalPrintSubmitting(false);
    }
  }

  if (urlAutomationMode) {
    return (
      <main className="url-automation-shell">
        <output
          className={`url-automation-minimal-status ${urlAutomationStatus?.type ?? 'loading'}`}
          aria-live="polite"
        >
          {urlAutomationStatus?.message ?? 'Processing URL input...'}
        </output>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <section className="viewer-panel" aria-label="CAD viewer">
        {appMode === 'assembly' ? (
          <AssemblyViewer
            assembly={assembly}
            selectedInstanceId={selectedAssemblyId}
            viewport={assemblyViewport}
            fullPreview={fullAssemblyPreview}
            menuOpen={previewMenuOpen}
            onInstanceSelect={selectAssemblyInstance}
            onViewportSelect={selectAssemblyViewport}
            onViewportDoubleSelect={toggleFullAssemblyPreview}
            onMenuToggle={() => setPreviewMenuOpen((open) => !open)}
            onPartMode={openPartMode}
          />
        ) : (
          <Viewer
            document={document}
            selectedId={selectedId}
            fullPreviewFace={fullPreviewFace}
            areaLocks={document.areaLocks}
            areaLockConstraints={document.areaLockConstraints}
            areaLockAvailability={areaLockAvailability}
            areaLockDiagnostics={areaLockDiagnostics}
            previewDimensions={previewDimensions}
            rotation={document.rotation}
            transparent3D={document.transparent3D}
            show3DGrid={document.show3DGrid}
            show3DEdges={document.show3DEdges}
            viewMode={document.viewMode}
            preview3DSelected={preview3DSelected}
            menuOpen={previewMenuOpen}
            onSelect={selectShape}
            onFaceSelect={setActiveFace}
            onFaceDoubleSelect={toggleFullPreview}
            onAreaLockToggle={toggleAreaLock}
            on3DSelect={select3DPreview}
            on3DDoubleSelect={toggle3DPreview}
            onMenuToggle={() => setPreviewMenuOpen((open) => !open)}
            onReset={requestScreenReset}
            onSaveOpen={() => openSavePanel('json')}
            onLoadOpen={openLoadPanel}
            onHelpOpen={openHelpPanel}
            onAssemblyOpen={openAssemblyMode}
            localPrintAvailable={Boolean(localPrintInfo)}
            onLocalPrintOpen={openLocalPrintDialog}
          />
        )}
      </section>

      <section ref={controlPanelRef} className="control-panel" aria-label="CAD controls">
        {urlAutomationStatus ? (
          <section
            className={`url-automation-status ${urlAutomationStatus.type}${urlAutomationMode ? ' automation' : ''}`}
            role={urlAutomationStatus.type === 'error' ? 'alert' : 'status'}
          >
            <strong>URL読込・自動出力</strong>
            <span>{urlAutomationStatus.message}</span>
            {!urlAutomationMode && urlDownloadArtifact ? (
              <button type="button" onClick={saveUrlDownloadArtifact}>
                {urlDownloadArtifact.extension.toUpperCase()}を手動保存
              </button>
            ) : null}
          </section>
        ) : null}
        {appMode === 'assembly' ? (
          <AssemblyPanel
            assembly={assembly}
            savedParts={savedParts}
            selectedInstance={selectedAssemblyInstance}
            selectedInstanceId={selectedAssemblyId}
            viewport={assemblyViewport}
            activeFace={assembly.activeFace}
            editorRefs={assemblyRefs}
            onAddInstance={addAssemblyInstance}
            onSelectInstance={(id) => selectAssemblyInstance(id, assemblyViewport)}
            onUpdateInstance={updateAssemblyInstance}
            onRemoveInstance={removeAssemblyInstance}
            onViewRotationChange={updateAssemblyViewRotation}
            onViewRotationReset={resetAssemblyViewRotation}
            onViewRotationPreset={setAssemblyViewRotation}
          />
        ) : null}

        {appMode === 'part' && showingFaceControls ? (
          <header className="control-header">
            <div>
              <p className="eyebrow">Oshida Smartphone CAD</p>
              <h1>図形配置</h1>
            </div>
            <div className="header-actions">
              <button
                type="button"
                className={document.showAllDimensions ? 'active-toggle' : ''}
                aria-pressed={document.showAllDimensions}
                onClick={toggleAllDimensions}
              >
                全寸法
              </button>
              <button type="button" onClick={() => addShape('rect')}>+四角</button>
              <button type="button" onClick={() => addShape('circle')}>+円</button>
              <button type="button" onClick={() => addShape('gear')}>+ギヤ</button>
              <button type="button" onClick={() => addShape('rack')}>+ラック</button>
              <button type="button" onClick={() => addShape('internalGear')}>+内歯</button>
            </div>
          </header>
        ) : null}

        {appMode === 'part' && showingFaceControls ? (
          <div className="document-controls">
            <div className="active-face-control" aria-label="配置面">
              <span>配置面</span>
              <strong className={`face-label face-${activeFace}`}>
                {FACE_LABELS[activeFace]}
              </strong>
            </div>
          </div>
        ) : null}

        {appMode === 'part' && showingFaceControls && areaLockFeedback ? (
          <AreaLockFeedback diagnostic={areaLockFeedback} />
        ) : null}

        {appMode === 'part' && showingFaceControls ? (
          <div className="shape-list">
            {activeShapes.map((shape, index) => (
              <ShapeEditor
                key={shape.id}
                editorRef={(node) => {
                  if (node) {
                    editorRefs.current.set(shape.id, node);
                  } else {
                    editorRefs.current.delete(shape.id);
                  }
                }}
                shape={shape}
                index={index}
                total={activeShapes.length}
                selected={shape.id === selectedId}
                locked={shape.mode !== 'cut' && hasAreaConstraint(lockedConstraints[normalizeFace(shape.face)])}
                constraint={lockedConstraints[normalizeFace(shape.face)]}
                onSelect={() => selectShape(shape.id)}
                onChange={(patch) => updateShape(shape.id, patch)}
                onMove={moveShape}
                onRemove={removeShape}
              />
            ))}
          </div>
        ) : null}

        {appMode === 'part' && showingFaceControls ? (
          selectedShape ? (
            <p className="selection-note">
              選択中: {FACE_LABELS[normalizeFace(selectedShape.face)]} / {getShapeLabel(selectedShape)}
            </p>
          ) : (
            <p className="selection-note">
              {FACE_LABELS[activeFace]}の図形: {activeShapes.length}件
            </p>
          )
        ) : null}

        {appMode === 'part' && showing3DControls ? (
          <RotationControls
            rotation={document.rotation}
            transparent={document.transparent3D}
            showGrid={document.show3DGrid}
            showEdges={document.show3DEdges}
            onChange={updateRotation}
            onReset={() => setRotation(DEFAULT_ROTATION)}
            onView={(view) => setRotation(FACE_VIEW_ROTATIONS[view])}
            onTransparencyChange={setTransparent3D}
            onGridChange={setShow3DGrid}
            onEdgesChange={setShow3DEdges}
          />
        ) : null}

        {appMode === 'part' && outputOpen ? (
          <OutputPanel
            format={outputFormat}
            jsonText={jsonText}
            stlReady={Boolean(previewDimensions)}
            stlSaving={stlSaving}
            stepSaving={stepSaving}
            meshResolution={stlResolution}
            meshResolutionMax={stlResolutionMax}
            partName={saveName}
            savedParts={savedParts}
            selectedSavedPartId={loadPartId}
            jsonImportStatus={jsonImportStatus}
            onFormatChange={setOutputFormat}
            onPartNameChange={updatePartName}
            onSavedPartSelect={setLoadPartId}
            onLoadPart={loadPart}
            onDeleteSavedPart={deleteSavedPart}
            onImportJson={importJsonFile}
            onImportJsonText={importJsonText}
            aiPrompt={AI_MODEL_JSON_PROMPT}
            onCopyAiPrompt={() => copyTextOutput(AI_MODEL_JSON_PROMPT)}
            onCopyJson={() => copyTextOutput(jsonText)}
            onSaveJson={() => saveTextOutput(jsonText, 'json', 'application/json')}
            onSaveWeb={savePartToWeb}
            onMeshResolutionChange={setStlResolution}
            onSaveStl={saveStlOutput}
            onSaveStep={saveStepOutput}
          />
        ) : null}
        <p className="app-credit">made by pscmps</p>
      </section>
      {resetConfirmOpen ? (
        <ConfirmDialog
          title="画面リセット"
          message="本当に画面をリセットしますか？"
          confirmLabel="はい"
          cancelLabel="いいえ"
          onConfirm={resetDocument}
          onCancel={() => setResetConfirmOpen(false)}
        />
      ) : null}
      {localPrintOpen ? (
        <LocalPrintDialog
          info={localPrintInfo}
          currentModelReady={Boolean(previewDimensions)}
          source={localPrintSource}
          file={localPrintFile}
          token={localPrintToken}
          status={localPrintStatus}
          submitting={localPrintSubmitting}
          layerHeight={localPrintLayerHeight}
          support={localPrintSupport}
          onSourceChange={setLocalPrintSource}
          onFileChange={setLocalPrintFile}
          onTokenChange={setLocalPrintToken}
          onLayerHeightChange={setLocalPrintLayerHeight}
          onSupportChange={setLocalPrintSupport}
          onSubmit={submitLocalPrint}
          onClose={() => !localPrintSubmitting && setLocalPrintOpen(false)}
        />
      ) : null}
    </main>
  );
}

function Viewer({
  document,
  selectedId,
  fullPreviewFace,
  areaLocks,
  areaLockConstraints,
  areaLockAvailability,
  areaLockDiagnostics,
  previewDimensions,
  rotation,
  transparent3D,
  show3DGrid,
  show3DEdges,
  viewMode,
  preview3DSelected,
  menuOpen,
  onSelect,
  onFaceSelect,
  onFaceDoubleSelect,
  onAreaLockToggle,
  on3DSelect,
  on3DDoubleSelect,
  onMenuToggle,
  onReset,
  onSaveOpen,
  onLoadOpen,
  onHelpOpen,
  onAssemblyOpen,
  localPrintAvailable,
  onLocalPrintOpen,
}) {
  const activeFace = normalizeFace(document.activeFace);
  const previewFace = fullPreviewFace ? normalizeFace(fullPreviewFace) : null;
  const is3DMode = viewMode === '3d' && previewDimensions;
  const visibleFaces = previewFace ? [previewFace] : FACE_ORDER;
  const faceBounds = useMemo(
    () => Object.fromEntries(FACE_ORDER.map((face) => [face, getFaceBounds(document.shapes, face)])),
    [document.shapes],
  );
  const faceConstraints = useMemo(
    () => getAllDisplayConstraints({ ...document, areaLocks, areaLockConstraints }, faceBounds),
    [document, areaLocks, areaLockConstraints, faceBounds],
  );
  const projectionReadiness = useMemo(
    () => getProjectionReadiness(faceBounds, areaLocks, areaLockConstraints),
    [faceBounds, areaLocks, areaLockConstraints],
  );
  return (
    <div className="viewer-frame">
      <div className="viewer-toolbar">
        <div className="viewer-toolbar-info">
          <span>3面図</span>
          <span>{APP_VERSION}</span>
        </div>
        <div className="viewer-menu">
          <button
            type="button"
            className="viewer-menu-button"
            aria-label="プレビューメニュー"
            aria-expanded={menuOpen}
            onClick={onMenuToggle}
          >
            ☰
          </button>
          {menuOpen ? (
            <div className="viewer-menu-popover">
              <button type="button" onClick={onSaveOpen}>保存</button>
              <button type="button" onClick={onLoadOpen}>呼び出し</button>
              <button type="button" onClick={onHelpOpen}>ヘルプ</button>
              {localPrintAvailable ? (
                <button type="button" onClick={onLocalPrintOpen}>ローカル3Dプリント</button>
              ) : null}
              <button type="button" onClick={onAssemblyOpen}>アセンブリ(開発中)</button>
              <button type="button" onClick={onReset}>画面リセット</button>
            </div>
          ) : null}
        </div>
      </div>
      <svg className="tri-view" viewBox="0 0 386 280" role="img" aria-label="3面配置図">
        <defs>
          <pattern id="grid" width="10" height="10" patternUnits="userSpaceOnUse">
            <path d="M 10 0 L 0 0 0 10" fill="none" stroke="#d8dee9" strokeWidth="0.35" />
          </pattern>
          <marker id="dimension-arrow" markerWidth="4" markerHeight="4" refX="2" refY="2" orient="auto-start-reverse">
            <path d="M 0 0 L 4 2 L 0 4 Z" />
          </marker>
          {FACE_ORDER.map((face) => (
            <mask key={face} id={`body-mask-${face}`}>
              <rect width="120" height="120" fill="black" />
              {document.shapes
                .filter((shape) => normalizeFace(shape.face) === face)
                .map((shape) => (
                  <MaskShape key={shape.id} shape={shape} />
                ))}
            </mask>
          ))}
        </defs>
        {is3DMode ? (
          <IsometricPreview
            dimensions={previewDimensions}
            shapes={document.shapes}
            rotation={rotation}
            transparent={transparent3D}
            showGrid={show3DGrid}
            showEdges={show3DEdges}
            expanded
            onDoubleSelect={on3DDoubleSelect}
          />
        ) : (
          <>
            {visibleFaces.map((face) => (
              <FacePlan
                key={face}
                face={face}
                active={!preview3DSelected && face === activeFace}
                full={Boolean(previewFace)}
                shapes={document.shapes.filter((shape) => normalizeFace(shape.face) === face)}
                constraint={faceConstraints[face]}
                axisReadiness={projectionReadiness[face]}
                showAllDimensions={document.showAllDimensions}
                selectedId={selectedId}
                onSelect={onSelect}
                onFaceSelect={onFaceSelect}
                onFaceDoubleSelect={onFaceDoubleSelect}
              />
            ))}
            {visibleFaces.map((face) => (
              <AreaLockButton
                key={`lock-${face}`}
                face={face}
                full={Boolean(previewFace)}
                locked={Boolean(areaLocks?.[face])}
                disabled={!areaLocks?.[face] && !areaLockAvailability?.[face]}
                diagnostic={areaLockDiagnostics?.[face]}
                onToggle={onAreaLockToggle}
              />
            ))}
            {!previewFace && previewDimensions ? (
              <IsometricPreview
                dimensions={previewDimensions}
                shapes={document.shapes}
                rotation={rotation}
                transparent={transparent3D}
                showGrid={show3DGrid}
                showEdges={show3DEdges}
                selected={preview3DSelected}
                onSelect={on3DSelect}
                onDoubleSelect={on3DDoubleSelect}
              />
            ) : null}
          </>
        )}
      </svg>
    </div>
  );
}

function getAssemblyInstanceSurfaces(instance) {
  const documentData = normalizeDocument(instance.document);
  const dimensions = getDocumentPreviewDimensions(documentData);
  if (!dimensions) {
    return [];
  }

  return buildSurfacePreviewFaces(documentData.shapes, dimensions).map((surface) => ({
    ...surface,
    instanceId: instance.id,
    instanceName: instance.name,
    color: instance.color,
    rings: surface.rings.map((ring) => ring.map((point) => {
      const rotated = rotatePoint(point, instance.rotation);
      return {
        x: rotated.x + instance.position.x,
        y: rotated.y + instance.position.y,
        z: rotated.z + instance.position.z,
      };
    })),
  }));
}

function getAssemblySurfaces(instances) {
  return instances.flatMap(getAssemblyInstanceSurfaces);
}

function getAssemblyBoundsFromSurfaces(surfaces) {
  const points = surfaces.flatMap((surface) => surface.rings.flat());
  const bounds = {};
  ['x', 'y', 'z'].forEach((axis) => {
    const values = [-180, 180, ...points.map((point) => point[axis])];
    const limit = Math.max(180, ...values.map((value) => Math.abs(value))) + 8;
    bounds[axis] = {
      min: -limit,
      max: limit,
      size: limit * 2,
    };
  });
  return bounds;
}

function getAssemblyFitBoundsFromSurfaces(surfaces) {
  const points = surfaces.flatMap((surface) => surface.rings.flat());
  if (!points.length) {
    return {
      x: { min: -60, max: 60, size: 120 },
      y: { min: -60, max: 60, size: 120 },
      z: { min: -60, max: 60, size: 120 },
    };
  }

  const bounds = {};
  ['x', 'y', 'z'].forEach((axis) => {
    const values = points.map((point) => point[axis]);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const padding = Math.max(4, (max - min) * 0.08);
    bounds[axis] = {
      min: min - padding,
      max: max + padding,
      size: Math.max(1, max - min + padding * 2),
    };
  });
  return bounds;
}

function getAssemblyProjectionAxes(face) {
  if (face === 'top') {
    return { horizontal: 'x', vertical: 'y' };
  }
  if (face === 'front') {
    return { horizontal: 'x', vertical: 'z' };
  }
  return { horizontal: 'y', vertical: 'z' };
}

function getAssemblyProjectedPoint(point, face, bounds) {
  const axes = getAssemblyProjectionAxes(face);
  const horizontalBounds = bounds[axes.horizontal];
  const verticalBounds = bounds[axes.vertical];
  return {
    sx: 10 + ((point[axes.horizontal] - horizontalBounds.min) / horizontalBounds.size) * 100,
    sy: 110 - ((point[axes.vertical] - verticalBounds.min) / verticalBounds.size) * 100,
  };
}

function getProjectedRingPath(ring) {
  return ring
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.sx} ${point.sy}`)
    .join(' ') + ' Z';
}

function getProjectedSurfacePathFrom3D(surface, face, bounds) {
  return surface.rings
    .map((ring) => getProjectedRingPath(ring.map((point) => getAssemblyProjectedPoint(point, face, bounds))))
    .join(' ');
}

function getProjectedInstanceBounds(surfaces, face, bounds) {
  const points = surfaces
    .flatMap((surface) => surface.rings.flat())
    .map((point) => getAssemblyProjectedPoint(point, face, bounds));
  if (!points.length) {
    return null;
  }
  return {
    minX: Math.min(...points.map((point) => point.sx)),
    maxX: Math.max(...points.map((point) => point.sx)),
    minY: Math.min(...points.map((point) => point.sy)),
    maxY: Math.max(...points.map((point) => point.sy)),
  };
}

function AssemblyViewer({
  assembly,
  selectedInstanceId,
  viewport,
  fullPreview,
  menuOpen,
  onInstanceSelect,
  onViewportSelect,
  onViewportDoubleSelect,
  onMenuToggle,
  onPartMode,
}) {
  const surfaces = useMemo(() => getAssemblySurfaces(assembly.instances), [assembly.instances]);
  const bounds = useMemo(() => getAssemblyBoundsFromSurfaces(surfaces), [surfaces]);
  const fitBounds = useMemo(() => getAssemblyFitBoundsFromSurfaces(surfaces), [surfaces]);
  const fullFace = fullPreview && fullPreview !== '3d' ? normalizeFace(fullPreview) : null;

  return (
    <div className="viewer-frame">
      <div className="viewer-toolbar">
        <div className="viewer-toolbar-info">
          <span>アセンブリ</span>
          <span>{APP_VERSION}</span>
        </div>
        <div className="viewer-menu">
          <button
            type="button"
            className="viewer-menu-button"
            aria-label="プレビューメニュー"
            aria-expanded={menuOpen}
            onClick={onMenuToggle}
          >
            ☰
          </button>
          {menuOpen ? (
            <div className="viewer-menu-popover">
              <button type="button" onClick={onPartMode}>単品部品</button>
            </div>
          ) : null}
        </div>
      </div>
      <svg className="tri-view assembly-view" viewBox="0 0 378 268" role="img" aria-label="アセンブリ配置図">
        {fullPreview === '3d' ? (
          <AssemblyIsoPreview
            surfaces={surfaces}
            bounds={fitBounds}
            rotation={assembly.viewRotation}
            selected
            expanded
            selectedInstanceId={selectedInstanceId}
            onSelect={() => onViewportSelect('3d')}
            onDoubleSelect={() => onViewportDoubleSelect('3d')}
            onInstanceSelect={(id) => onInstanceSelect(id, '3d')}
          />
        ) : (
          <>
            {(fullFace ? [fullFace] : FACE_ORDER).map((face) => (
              <AssemblyFaceProjection
                key={face}
                face={face}
                active={viewport === face}
                full={Boolean(fullFace)}
                surfaces={surfaces}
                bounds={bounds}
                selectedInstanceId={selectedInstanceId}
                onInstanceSelect={onInstanceSelect}
                onViewportSelect={onViewportSelect}
                onViewportDoubleSelect={onViewportDoubleSelect}
              />
            ))}
            {!fullFace ? (
              <AssemblyIsoPreview
                surfaces={surfaces}
                bounds={fitBounds}
                rotation={assembly.viewRotation}
                selected={viewport === '3d'}
                selectedInstanceId={selectedInstanceId}
                onSelect={() => onViewportSelect('3d')}
                onDoubleSelect={() => onViewportDoubleSelect('3d')}
                onInstanceSelect={(id) => onInstanceSelect(id, '3d')}
              />
            ) : null}
          </>
        )}
      </svg>
    </div>
  );
}

function AssemblyFaceProjection({
  face,
  active,
  full = false,
  surfaces,
  bounds,
  selectedInstanceId,
  onInstanceSelect,
  onViewportSelect,
  onViewportDoubleSelect,
}) {
  const instanceIds = [...new Set(surfaces.map((surface) => surface.instanceId))];

  return (
    <g
      className={`face-plan assembly-face face-${face} ${active ? 'active' : ''}`}
      transform={getFaceTransform(face, full)}
      role="button"
      tabIndex="0"
      aria-label={`アセンブリ ${FACE_LABELS[face]}`}
      onClick={() => onViewportSelect(face)}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onViewportDoubleSelect(face);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onViewportSelect(face);
        }
      }}
    >
      <rect className="face-plan-bg" width="120" height="120" rx="2" />
      <rect className="face-plan-surface" width="120" height="120" />
      <line x1="0" y1="60" x2="120" y2="60" className="face-axis" />
      <line x1="60" y1="0" x2="60" y2="120" className="face-axis" />
      {surfaces.map((surface, index) => (
        <path
          key={`${face}-${surface.instanceId}-${index}`}
          className="assembly-projection-surface"
          d={getProjectedSurfacePathFrom3D(surface, face, bounds)}
          fill={surface.color}
          stroke={surface.color}
        />
      ))}
      {instanceIds.map((instanceId) => {
        const instanceSurfaces = surfaces.filter((surface) => surface.instanceId === instanceId);
        const projectedBounds = getProjectedInstanceBounds(instanceSurfaces, face, bounds);
        if (!projectedBounds) {
          return null;
        }
        const selected = instanceId === selectedInstanceId;
        return (
          <rect
            key={`${face}-hit-${instanceId}`}
            className={`assembly-hit-area ${selected ? 'selected' : ''}`}
            x={projectedBounds.minX}
            y={projectedBounds.minY}
            width={projectedBounds.maxX - projectedBounds.minX}
            height={projectedBounds.maxY - projectedBounds.minY}
            onClick={(event) => {
              event.stopPropagation();
              onInstanceSelect(instanceId, face);
            }}
            onDoubleClick={(event) => {
              event.stopPropagation();
              onViewportDoubleSelect(face);
            }}
          />
        );
      })}
      <text className="face-plan-label" x="60" y="112">{FACE_LABELS[face]}</text>
    </g>
  );
}

function AssemblyIsoPreview({
  surfaces,
  bounds,
  rotation,
  selected,
  expanded = false,
  selectedInstanceId,
  onSelect,
  onDoubleSelect,
  onInstanceSelect,
}) {
  const box = expanded
    ? { x: 30, y: 12, width: 266, height: 240, labelY: 238 }
    : { x: 198, y: 6, width: 120, height: 120, labelY: 116 };
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 + (expanded ? 12 : 4) };
  const contentCenter = {
    x: (bounds.x.min + bounds.x.max) / 2,
    y: (bounds.y.min + bounds.y.max) / 2,
    z: (bounds.z.min + bounds.z.max) / 2,
  };
  const maxSize = Math.max(bounds.x.size, bounds.y.size, bounds.z.size);
  const scale = (expanded ? 104 : 50) / Math.max(1, maxSize);
  const projectedSurfaces = surfaces.map((surface) => {
    const projectedRings = surface.rings.map((ring) => ring.map((point) => {
      const rotated = rotatePoint({
        x: point.x - contentCenter.x,
        y: point.y - contentCenter.y,
        z: point.z - contentCenter.z,
      }, rotation);
      return {
        ...rotated,
        sx: center.x + rotated.x * scale,
        sy: center.y - rotated.z * scale,
      };
    }));
    const projectedPoints = projectedRings.flat();
    const depth = projectedPoints.reduce((sum, point) => sum + point.y, 0) / projectedPoints.length;
    return {
      ...surface,
      depth,
      projectedRings,
      path: getProjectedSurfacePath(projectedRings),
    };
  }).sort((a, b) => b.depth - a.depth);

  const instanceIds = [...new Set(projectedSurfaces.map((surface) => surface.instanceId))];

  return (
    <g
      className={`iso-preview assembly-iso ${expanded ? 'expanded' : ''} ${selected ? 'selected' : ''}`}
      aria-label="アセンブリ3Dプレビュー"
      onClick={(event) => {
        event.stopPropagation();
        onSelect();
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onDoubleSelect();
      }}
    >
      <rect className="iso-preview-frame" x={box.x} y={box.y} width={box.width} height={box.height} rx="4" />
      {projectedSurfaces.map((surface, index) => (
        <g key={`assembly-iso-${surface.instanceId}-${index}`}>
          <path
            className="assembly-iso-surface"
            d={surface.path}
            fill={surface.color}
            stroke={surface.color}
            onClick={(event) => {
              event.stopPropagation();
              onInstanceSelect(surface.instanceId);
            }}
            onDoubleClick={(event) => {
              event.stopPropagation();
              onDoubleSelect();
            }}
          />
          {surface.projectedRings.flatMap((ring, ringIndex) =>
            ring.map((point, pointIndex) => {
              const next = ring[(pointIndex + 1) % ring.length];
              return (
                <line
                  key={`${index}-${ringIndex}-${pointIndex}`}
                  className="iso-preview-outline-edge"
                  x1={point.sx}
                  y1={point.sy}
                  x2={next.sx}
                  y2={next.sy}
                />
              );
            }),
          )}
        </g>
      ))}
      {instanceIds.map((instanceId) => {
        const points = projectedSurfaces
          .filter((surface) => surface.instanceId === instanceId)
          .flatMap((surface) => surface.projectedRings.flat());
        if (!points.length) {
          return null;
        }
        const minX = Math.min(...points.map((point) => point.sx));
        const maxX = Math.max(...points.map((point) => point.sx));
        const minY = Math.min(...points.map((point) => point.sy));
        const maxY = Math.max(...points.map((point) => point.sy));
        return (
          <rect
            key={`assembly-iso-hit-${instanceId}`}
            className={`assembly-hit-area ${instanceId === selectedInstanceId ? 'selected' : ''}`}
            x={minX}
            y={minY}
            width={maxX - minX}
            height={maxY - minY}
            onClick={(event) => {
              event.stopPropagation();
              onInstanceSelect(instanceId);
            }}
            onDoubleClick={(event) => {
              event.stopPropagation();
              onDoubleSelect();
            }}
          />
        );
      })}
      <text x={box.x + box.width / 2} y={box.labelY}>3D assembly</text>
    </g>
  );
}

function ConfirmDialog({ title, message, confirmLabel, cancelLabel, onConfirm, onCancel }) {
  return (
    <div className="dialog-backdrop" role="presentation">
      <div
        className="part-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <h2>{title}</h2>
        </header>
        <p className="dialog-message">{message}</p>
        <div className="dialog-actions">
          <button type="button" onClick={onConfirm}>{confirmLabel}</button>
          <button type="button" onClick={onCancel}>{cancelLabel}</button>
        </div>
      </div>
    </div>
  );
}

function LocalPrintDialog({
  info,
  currentModelReady,
  source,
  file,
  token,
  status,
  submitting,
  layerHeight,
  support,
  onSourceChange,
  onFileChange,
  onTokenChange,
  onLayerHeightChange,
  onSupportChange,
  onSubmit,
  onClose,
}) {
  const canSubmit = !submitting
    && (source === 'current' ? currentModelReady : Boolean(file))
    && (!info?.tokenRequired || Boolean(token.trim()));

  return (
    <div className="dialog-backdrop" role="presentation">
      <div className="part-dialog local-print-dialog" role="dialog" aria-modal="true" aria-label="ローカル3Dプリント">
        <header><h2>ローカル3Dプリント</h2></header>
        <p className="local-print-printer">送信先: {info?.printerName || 'ローカルプリンタ'}</p>
        <div className="local-print-source" role="radiogroup" aria-label="印刷データ">
          <label>
            <input
              type="radio"
              name="local-print-source"
              value="current"
              checked={source === 'current'}
              disabled={!currentModelReady || submitting}
              onChange={() => onSourceChange('current')}
            />
            現在のCADモデル
          </label>
          <label>
            <input
              type="radio"
              name="local-print-source"
              value="file"
              checked={source === 'file'}
              disabled={submitting}
              onChange={() => onSourceChange('file')}
            />
            STLファイル
          </label>
        </div>
        {source === 'file' ? (
          <label className="dialog-field">
            STLファイル
            <input
              type="file"
              accept=".stl,model/stl,application/octet-stream"
              disabled={submitting}
              onChange={(event) => onFileChange(event.target.files?.[0] || null)}
            />
          </label>
        ) : null}
        {info?.tokenRequired ? (
          <label className="dialog-field">
            Receiver token
            <input
              type="password"
              value={token}
              autoComplete="current-password"
              disabled={submitting}
              onChange={(event) => onTokenChange(event.target.value)}
            />
          </label>
        ) : null}
        <div className="local-print-settings">
          <label className="dialog-field">
            レイヤー高さ
            <select
              value={layerHeight}
              disabled={submitting}
              onChange={(event) => onLayerHeightChange(event.target.value)}
            >
              <option value="0.08">0.08 mm（高精細）</option>
              <option value="0.12">0.12 mm</option>
              <option value="0.16">0.16 mm</option>
              <option value="0.20">0.20 mm（標準）</option>
              <option value="0.24">0.24 mm</option>
              <option value="0.28">0.28 mm（高速）</option>
            </select>
          </label>
          <label className="local-print-support">
            <input
              type="checkbox"
              checked={support}
              disabled={submitting}
              onChange={(event) => onSupportChange(event.target.checked)}
            />
            サポートを自動生成
          </label>
        </div>
        <p className="local-print-warning">送信するとスライス後に実際の印刷を開始します。プリンタとベッドを確認してください。</p>
        {status ? <output className={`local-print-status ${status.type}`} aria-live="polite">{status.message}</output> : null}
        <div className="dialog-actions">
          <button type="button" onClick={onClose} disabled={submitting}>閉じる</button>
          <button type="button" onClick={onSubmit} disabled={!canSubmit}>
            {submitting ? '処理中...' : '送信して印刷'}
          </button>
        </div>
      </div>
    </div>
  );
}

function getAssemblyMoveAxes(viewport) {
  if (viewport === '3d') {
    return ['x', 'y', 'z'];
  }
  if (viewport === 'top') {
    return ['x', 'y'];
  }
  if (viewport === 'front') {
    return ['x', 'z'];
  }
  return ['y', 'z'];
}

function getAssemblyControlAxis(axis, viewport) {
  if (viewport === '3d') {
    return 'x';
  }
  return axis === 'z' ? 'y' : 'x';
}

function getAssemblyAxisLabel(axis) {
  return axis.toUpperCase();
}

function AssemblyPanel({
  assembly,
  savedParts,
  selectedInstance,
  selectedInstanceId,
  viewport,
  activeFace,
  editorRefs,
  onAddInstance,
  onSelectInstance,
  onUpdateInstance,
  onRemoveInstance,
  onViewRotationChange,
  onViewRotationReset,
  onViewRotationPreset,
}) {
  const [selectedPartId, setSelectedPartId] = useState(savedParts[0]?.id ?? '');
  const hasSavedParts = savedParts.length > 0;
  const selectedPart = savedParts.find((part) => part.id === selectedPartId);
  const selectedPartReady = Boolean(selectedPart && getDocumentPreviewDimensions(selectedPart.document));
  const activeViewLabel = viewport === '3d' ? '3D' : FACE_LABELS[activeFace];

  useEffect(() => {
    if (savedParts.length && !savedParts.some((part) => part.id === selectedPartId)) {
      setSelectedPartId(savedParts[0].id);
      return;
    }
    if (!savedParts.length && selectedPartId) {
      setSelectedPartId('');
    }
  }, [savedParts, selectedPartId]);

  return (
    <section className="assembly-panel" aria-label="アセンブリ">
      <header className="control-header">
        <div>
          <p className="eyebrow">Oshida Smartphone CAD</p>
          <h1>アセンブリ</h1>
        </div>
      </header>

      <AssemblyViewControls
        rotation={assembly.viewRotation}
        onChange={onViewRotationChange}
        onReset={onViewRotationReset}
        onView={(view) => onViewRotationPreset(FACE_VIEW_ROTATIONS[view])}
      />

      <div className="part-storage-panel assembly-load-panel">
        <h2>部品配置</h2>
        <label className="saved-part-field">
          <span>web保存データ</span>
          <select
            value={selectedPartId}
            disabled={!hasSavedParts}
            onChange={(event) => setSelectedPartId(event.target.value)}
          >
            {hasSavedParts ? savedParts.map((part) => (
              <option key={part.id} value={part.id}>{part.name}</option>
            )) : (
              <option value="">保存データなし</option>
            )}
          </select>
        </label>
        <div className="saved-part-actions">
          <button
            type="button"
            onClick={() => onAddInstance(selectedPartId)}
            disabled={!hasSavedParts || !selectedPartId || !selectedPartReady}
          >
            配置
          </button>
        </div>
        {!hasSavedParts ? (
          <p className="assembly-note">単品部品をweb保存するとここから配置できます。</p>
        ) : null}
        {selectedPart && !selectedPartReady ? (
          <p className="assembly-note danger-text">この部品は3面寸法を決められないため配置できません。</p>
        ) : null}
      </div>

      <div className="active-face-control assembly-active-face">
        <span>{viewport === '3d' ? '操作ビュー' : '操作面'}</span>
        <strong className={`face-label ${viewport === '3d' ? 'assembly-view-label' : `face-${activeFace}`}`}>
          {activeViewLabel}
        </strong>
      </div>

      <div className="assembly-list">
        {assembly.instances.length ? assembly.instances.map((instance) => (
          <AssemblyInstanceEditor
            key={instance.id}
            editorRef={(node) => {
              if (node) {
                editorRefs.current.set(instance.id, node);
              } else {
                editorRefs.current.delete(instance.id);
              }
            }}
            instance={instance}
            selected={instance.id === selectedInstanceId}
            viewport={viewport}
            onSelect={() => onSelectInstance(instance.id)}
            onChange={(patch) => onUpdateInstance(instance.id, patch)}
            onRemove={() => onRemoveInstance(instance.id)}
          />
        )) : (
          <div className="output-placeholder">
            部品を配置するとここに一覧表示されます。
          </div>
        )}
      </div>

      {selectedInstance ? (
        <p className="selection-note">選択中: {selectedInstance.name}</p>
      ) : (
        <p className="selection-note">右上の3D、または各面の部品をタップして選択できます。</p>
      )}
    </section>
  );
}

function AssemblyViewControls({ rotation, onChange, onReset, onView }) {
  return (
    <section className="rotation-panel assembly-view-controls" aria-label="アセンブリ画面回転">
      <div className="rotation-header">
        <span>画面回転</span>
      </div>
      <div className="rotation-grid">
        {['x', 'y', 'z'].map((axis) => (
          <label key={axis} className="rotation-field">
            <span>{axis.toUpperCase()}</span>
            <input
              type="range"
              min="-180"
              max="180"
              step="1"
              value={rotation[axis]}
              onChange={(event) => onChange(axis, Number(event.target.value))}
            />
            <NumberField
              label={`${axis} assembly view rotation`}
              value={rotation[axis]}
              min={-180}
              max={180}
              compact
              onChange={(value) => onChange(axis, value)}
            />
          </label>
        ))}
      </div>
      <div className="assembly-view-actions">
        <button type="button" onClick={onReset}>初期角度</button>
        <div className="view-net" aria-label="アセンブリ方向プリセット">
          <button type="button" className="view-top" onClick={() => onView('top')}>上面</button>
          <button type="button" className="view-left" onClick={() => onView('left')}>左側面</button>
          <button type="button" className="view-front" onClick={() => onView('front')}>正面</button>
          <button type="button" className="view-right" onClick={() => onView('right')}>右側面</button>
          <button type="button" className="view-bottom" onClick={() => onView('bottom')}>底面</button>
          <button type="button" className="view-back" onClick={() => onView('back')}>背面</button>
        </div>
      </div>
    </section>
  );
}

function AssemblyInstanceEditor({
  editorRef,
  instance,
  selected,
  viewport,
  onSelect,
  onChange,
  onRemove,
}) {
  const moveAxes = getAssemblyMoveAxes(viewport);

  function updatePosition(axis, value) {
    onChange({
      position: {
        ...instance.position,
        [axis]: value,
      },
    });
  }

  function updateRotation(axis, value) {
    onChange({
      rotation: {
        ...instance.rotation,
        [axis]: value,
      },
    });
  }

  return (
    <article ref={editorRef} className={`assembly-card ${selected ? 'selected' : ''}`}>
      <header className="assembly-card-top">
        <button type="button" className="assembly-title" onClick={onSelect}>
          <span className="assembly-color-dot" style={{ backgroundColor: instance.color }} />
          <span>{instance.name}</span>
        </button>
        <input
          className="assembly-color-input"
          type="color"
          value={instance.color}
          aria-label={`${instance.name} color`}
          onChange={(event) => onChange({ color: event.target.value })}
        />
        <button type="button" className="danger" onClick={onRemove}>削除</button>
      </header>

      <div className="assembly-section-label">位置</div>
      <div className={`shape-control-grid assembly-position-grid ${viewport === '3d' ? 'three-axis' : ''}`}>
        {moveAxes.map((axis, index) => (
          <ControlField
            key={axis}
            axis={getAssemblyControlAxis(axis, viewport)}
            label={getAssemblyAxisLabel(axis)}
            value={instance.position[axis]}
            min={-120}
            max={120}
            invert={viewport !== '3d' && index === 1}
            onChange={(value) => updatePosition(axis, value)}
          />
        ))}
      </div>

      <div className="assembly-section-label">部品回転</div>
      <div className="assembly-rotation-grid">
        {['x', 'y', 'z'].map((axis) => (
          <label key={axis} className="rotation-field assembly-rotation-field">
            <span>{axis.toUpperCase()}</span>
            <input
              type="range"
              min="-180"
              max="180"
              step="90"
              value={instance.rotation[axis]}
              onChange={(event) => updateRotation(axis, Number(event.target.value))}
            />
            <NumberField
              label={`${axis} part rotation`}
              value={instance.rotation[axis]}
              min={-180}
              max={180}
              compact
              onChange={(value) => updateRotation(axis, snapRightAngle(value))}
            />
          </label>
        ))}
      </div>
    </article>
  );
}

function OutputPanel({
  format,
  jsonText,
  stlReady,
  stlSaving,
  stepSaving,
  meshResolution,
  meshResolutionMax,
  partName,
  savedParts,
  selectedSavedPartId,
  jsonImportStatus,
  onFormatChange,
  onPartNameChange,
  onSavedPartSelect,
  onLoadPart,
  onDeleteSavedPart,
  onImportJson,
  onImportJsonText,
  aiPrompt,
  onCopyAiPrompt,
  onCopyJson,
  onSaveJson,
  onSaveWeb,
  onMeshResolutionChange,
  onSaveStl,
  onSaveStep,
}) {
  const [pastedJson, setPastedJson] = useState('');
  const [promptCopied, setPromptCopied] = useState(false);
  const meshSaving = stlSaving || stepSaving;
  const hasSavedParts = savedParts.length > 0;
  const meshResolutionControl = (
    <label className="stl-resolution-control">
      <span>分割</span>
      <input
        type="range"
        min="1"
        max={meshResolutionMax}
        step="0.1"
        value={meshResolution}
        disabled={meshSaving || meshResolutionMax <= 1}
        onChange={(event) => onMeshResolutionChange(Number(event.target.value))}
      />
      <strong>{meshResolution.toFixed(1)}x</strong>
    </label>
  );

  return (
    <section className="output-panel" aria-label="保存">
      <header className="output-header">
        <div>
          <p className="eyebrow">Oshida Smartphone CAD</p>
          <h1>{format === 'help' ? 'ヘルプ' : format === 'load' ? '呼び出し' : '保存'}</h1>
        </div>
      </header>
      {format !== 'help' && format !== 'load' ? (
        <>
          <div className="part-storage-panel save-panel">
            <h2>保存</h2>
            <label className="part-name-field">
              <span>名前</span>
              <input
                type="text"
                value={partName}
                onChange={(event) => onPartNameChange(event.target.value)}
              />
            </label>
            <p className="web-save-warning">
              web保存はブラウザ内に保存されます。キャッシュやサイトデータを消すと削除されます。
            </p>
          </div>
          <div className="output-tabs" role="tablist" aria-label="保存形式">
            {['json', 'stl', 'step'].map((item) => (
              <button
                key={item}
                type="button"
                className={format === item ? 'active' : ''}
                onClick={() => onFormatChange(item)}
              >
                {item.toUpperCase()}
              </button>
            ))}
          </div>
        </>
      ) : null}
      {format === 'load' ? (
        <div className="load-sections">
          <div className="part-storage-panel load-panel">
            <h2>JSONファイル</h2>
            <label className="json-file-field">
              <span>ローカルファイル</span>
              <input
                type="file"
                accept=".json,application/json"
                disabled={jsonImportStatus?.type === 'loading'}
                onChange={(event) => {
                  const [file] = event.target.files;
                  if (file) {
                    onImportJson(file);
                  }
                  event.target.value = '';
                }}
              />
            </label>
            <p className="load-note">JSON保存したモデル、または同じschemaに沿ったJSONを読み込めます。</p>
          </div>
          <div className="part-storage-panel load-panel">
            <h2>JSON貼り付け</h2>
            <label className="json-paste-field">
              <span>JSON</span>
              <textarea
                value={pastedJson}
                rows="10"
                spellCheck="false"
                placeholder='{"schemaVersion": 4, ...}'
                onChange={(event) => setPastedJson(event.target.value)}
              />
            </label>
            <div className="output-actions">
              <button
                type="button"
                disabled={!pastedJson.trim()}
                onClick={() => onImportJsonText(pastedJson)}
              >
                読み込む
              </button>
              <button type="button" disabled={!pastedJson} onClick={() => setPastedJson('')}>
                クリア
              </button>
            </div>
          </div>
          {jsonImportStatus ? (
            <p className={`json-import-status ${jsonImportStatus.type}`} role="status">
              {jsonImportStatus.message}
            </p>
          ) : null}
          <div className="part-storage-panel load-panel">
            <h2>web保存データ</h2>
            <label className="saved-part-field">
              <span>呼び出しデータ</span>
              <select
                value={selectedSavedPartId}
                disabled={!hasSavedParts}
                onChange={(event) => onSavedPartSelect(event.target.value)}
              >
                {hasSavedParts ? savedParts.map((part) => (
                  <option key={part.id} value={part.id}>{part.name}</option>
                )) : (
                  <option value="">保存データなし</option>
                )}
              </select>
            </label>
            <div className="saved-part-actions">
              <button type="button" onClick={onLoadPart} disabled={!hasSavedParts || !selectedSavedPartId}>
                呼び出し
              </button>
              <button type="button" onClick={onDeleteSavedPart} disabled={!hasSavedParts || !selectedSavedPartId}>
                削除
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {format === 'json' ? (
          <div className="output-content">
            <div className="output-actions">
              <button type="button" onClick={onCopyJson}>コピー</button>
              <button type="button" onClick={onSaveJson}>保存</button>
              <button type="button" onClick={onSaveWeb} disabled={!partName.trim()}>web保存</button>
            </div>
            <pre className="json-view">{jsonText}</pre>
          </div>
      ) : null}
      {format === 'stl' ? (
        stlReady ? (
          <div className="output-content">
            <div className="output-actions">
              <button type="button" onClick={onSaveStl} disabled={stlSaving}>
                {stlSaving ? '生成中...' : '保存'}
              </button>
            </div>
            {meshResolutionControl}
            <div className="output-placeholder">
              STLは保存時にスライサー向けの閉じたメッシュで生成します。
            </div>
          </div>
        ) : (
          <div className="output-placeholder">
            3面をロックするとSTL保存できます。
          </div>
        )
      ) : null}
      {format === 'step' ? (
        stlReady ? (
          <div className="output-content">
            <div className="output-actions">
              <button type="button" onClick={onSaveStep} disabled={stepSaving}>
                {stepSaving ? '生成中...' : '保存'}
              </button>
            </div>
            <div className="output-placeholder">
              STEPは保存時にOpenCascadeでB-repとして生成します。
            </div>
          </div>
        ) : (
          <div className="output-placeholder">
            3面をロックするとSTEP保存できます。
          </div>
        )
      ) : null}
      {format === 'help' ? (
        <HelpPanel
          aiPrompt={aiPrompt}
          promptCopied={promptCopied}
          onCopyAiPrompt={async () => {
            await onCopyAiPrompt();
            setPromptCopied(true);
            window.setTimeout(() => setPromptCopied(false), 1800);
          }}
        />
      ) : null}
    </section>
  );
}

function HelpPanel({ aiPrompt, promptCopied, onCopyAiPrompt }) {
  return (
    <div className="help-panel">
      <h2>基本の流れ</h2>
      <ol>
        <li>上面に図形を置き、エリアをロックします。</li>
        <li>正面に図形を置き、エリアをロックします。</li>
        <li>右側面に図形を置き、エリアをロックします。</li>
        <li>3面すべてが成り立つと、右上に3Dプレビューが表示されます。</li>
      </ol>
      <h2>操作</h2>
      <ul>
        <li>「+ギヤ」では20度圧力角の平歯車を追加し、モジュール・歯数・中央穴径を調整できます。</li>
        <li>「+ラック」では20度圧力角のラックギヤを追加し、モジュール・歯数・歯先からの全高を調整できます。</li>
        <li>「+内歯」では20度圧力角の内歯車を追加し、モジュール・歯数・外径を成立範囲内で調整できます。</li>
        <li>図形をタップすると、その図形の編集UIへ移動します。</li>
        <li>図形以外をタップすると、その面の先頭へ戻ります。</li>
        <li>面をダブルタップすると、その面だけを拡大表示します。もう一度ダブルタップすると3面図へ戻ります。</li>
        <li>3Dプレビューをタップすると、回転・透過・グリッド・エッジの表示を調整できます。</li>
        <li>3Dプレビューをダブルタップすると、3D表示を拡大します。</li>
      </ul>
      <h2>保存</h2>
      <ul>
        <li>JSONは現在の編集データです。ファイル保存、ファイル読込、web保存ができます。</li>
        <li>STLはスライサー向けのメッシュとして保存します。</li>
        <li>STEPはOpenCascadeでCAD向けのB-repとして保存します。</li>
      </ul>
      <h2>AIでJSONを作る</h2>
      <p className="help-copy">下の指示文をAIへ貼り付け、最後の「作りたい部品の要件」を書き換えてください。返されたJSONは呼び出し画面へそのまま貼り付けられます。</p>
      <div className="ai-prompt-actions">
        <button type="button" onClick={onCopyAiPrompt}>
          {promptCopied ? 'コピーしました' : 'AI指示文をコピー'}
        </button>
      </div>
      <details className="ai-prompt-details">
        <summary>指示文を表示</summary>
        <pre>{aiPrompt}</pre>
      </details>
      <h2>ロックのヒント</h2>
      <ul>
        <li>ロックは、その面の外形範囲を他の面へ反映して、3Dとして矛盾しない配置範囲を固定する機能です。</li>
        <li>薄く表示されたロックボタンもタップできます。ロックできない場合は、幅・奥行・高さの不一致範囲を下に表示します。</li>
        <li>未ロック面の薄い灰色矢印は、ロック済み面が決めた固定範囲です。現在の図形範囲は赤矢印で重なり、両端が一致すると緑の矢印と○になります。図形がない時は灰色矢印だけ表示し、ロック後は消えます。</li>
        <li>ロックできない時は、他の面の図形が灰色の禁止エリアにはみ出していないか確認してください。</li>
        <li>共有範囲は、上面X＝正面X、上面Y＝右側面X、正面Y＝右側面Yです。サイズだけでなく開始・終了位置も合わせてください。</li>
        <li>JSONのextrude値は互換用で、奥行の指定には使われません。奥行は上面Yと右側面Xで決まります。</li>
        <li>cut図形で外形を凹ませる場合は、図形の順番が影響します。後ろのaddは前のcutを上書きできます。</li>
        <li>上面は幅と奥行き、正面は幅と高さ、右側面は奥行きと高さに影響します。</li>
        <li>3面すべてをロックすると、3DプレビューとSTL/STEP保存が使えるようになります。</li>
      </ul>
    </div>
  );
}

function getAreaLockTransform(face, full) {
  if (full) {
    return 'translate(48 22)';
  }
  if (face === 'right') {
    return 'translate(332 190)';
  }
  if (face === 'front') {
    return 'translate(6 190)';
  }
  return 'translate(6 54)';
}

function AreaLockButton({ face, full, locked, disabled, diagnostic, onToggle }) {
  return (
    <g
      className={`area-lock-button face-${face} ${locked ? 'locked' : ''} ${disabled ? 'disabled' : ''}`}
      transform={getAreaLockTransform(face, full)}
      role="button"
      tabIndex="0"
      aria-label={`${FACE_LABELS[face]} エリアロック`}
      aria-disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onToggle(face);
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onToggle(face);
        }
      }}
    >
      <title>{disabled ? 'タップするとロックできない理由を表示します' : `${FACE_LABELS[face]}をロック`}</title>
      <rect width="50" height="24" rx="5" />
      <text x="25" y="16">エリア</text>
      <text x="43" y="16">🔒</text>
    </g>
  );
}

function AreaLockFeedback({ diagnostic }) {
  if (diagnostic.reason === 'missing-shape') {
    return (
      <section className="area-lock-feedback" role="alert">
        <strong>{FACE_LABELS[diagnostic.face]}をロックできません</strong>
        <p>この面に外形を作るadd図形がありません。</p>
      </section>
    );
  }

  return (
    <section className="area-lock-feedback" role="alert">
      <strong>{FACE_LABELS[diagnostic.face]}をロックできません</strong>
      {diagnostic.violations.map((violation, index) => {
        const sourceLabels = violation.sourceFaces.map((face) => FACE_LABELS[face]).join('・');
        return (
          <div key={`${violation.targetFace}-${violation.axis}-${index}`} className="area-lock-violation">
            <b>
              {violation.matchMode === 'exact-edges'
                ? `${DIMENSION_LABELS[violation.dimension]}の両端が一致していません`
                : `${DIMENSION_LABELS[violation.dimension]}範囲が一致していません`}
            </b>
            <span>{FACE_LABELS[violation.targetFace]}: {formatRange(violation.actualMin, violation.actualMax)}</span>
            <span>許容範囲: {formatRange(violation.expectedMin, violation.expectedMax)}</span>
            <small>{sourceLabels || 'ロック済み面'}と共有する{DIMENSION_LABELS[violation.dimension]}の開始・終了位置を合わせてください。</small>
          </div>
        );
      })}
    </section>
  );
}

function rotatePoint(point, rotation) {
  const xRad = (rotation.x * Math.PI) / 180;
  const yRad = (rotation.y * Math.PI) / 180;
  const zRad = (rotation.z * Math.PI) / 180;
  let { x, y, z } = point;
  let nextY = y * Math.cos(xRad) - z * Math.sin(xRad);
  let nextZ = y * Math.sin(xRad) + z * Math.cos(xRad);
  y = nextY;
  z = nextZ;

  let nextX = x * Math.cos(yRad) + z * Math.sin(yRad);
  nextZ = -x * Math.sin(yRad) + z * Math.cos(yRad);
  x = nextX;
  z = nextZ;

  nextX = x * Math.cos(zRad) - y * Math.sin(zRad);
  nextY = x * Math.sin(zRad) + y * Math.cos(zRad);
  return { x: nextX, y: nextY, z };
}

function getProjectedSurfacePath(rings) {
  return rings
    .map((ring) => ring
      .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.sx} ${point.sy}`)
      .join(' '))
    .map((path) => `${path} Z`)
    .join(' ');
}

function getSurfaceEdgeKey(surface, ringIndex, pointIndex) {
  const ring = surface.rings[ringIndex];
  const nextIndex = (pointIndex + 1) % ring.length;
  const pointKey = (point) => `${point.x.toFixed(4)}:${point.y.toFixed(4)}:${point.z.toFixed(4)}`;
  return [
    surface.className,
    [pointKey(ring[pointIndex]), pointKey(ring[nextIndex])].sort().join('|'),
  ].join('|');
}

function IsometricPreview({
  dimensions,
  shapes,
  rotation,
  transparent = false,
  showGrid = true,
  showEdges = true,
  expanded = false,
  selected = false,
  onSelect,
  onDoubleSelect,
}) {
  const box = expanded
    ? { x: 30, y: 12, width: 266, height: 240, labelY: 238 }
    : { x: 198, y: 6, width: 120, height: 120, labelY: 116 };
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 + (expanded ? 12 : 4) };
  const maxSize = Math.max(dimensions.width.size, dimensions.depth.size, dimensions.height.size);
  const scale = (expanded ? 96 : 48) / maxSize;
  const surfaces = useMemo(() => buildSurfacePreviewFaces(shapes, dimensions), [shapes, dimensions]);
  const projectedSurfaces = surfaces.map((surface) => {
    const projectedRings = surface.rings.map((ring) => ring.map((point) => {
      const rotated = rotatePoint(point, rotation);
      return {
        ...rotated,
        sx: center.x + rotated.x * scale,
        sy: center.y - rotated.z * scale,
      };
    }));
    const projectedPoints = projectedRings.flat();
    const depth = projectedPoints.reduce((sum, point) => sum + point.y, 0) / projectedPoints.length;
    return {
      ...surface,
      depth,
      projectedRings,
      path: getProjectedSurfacePath(projectedRings),
    };
  }).sort((a, b) => b.depth - a.depth);
  const edgeUsage = new Map();
  surfaces.forEach((surface) => {
    if (surface.edge === false) {
      return;
    }
    surface.rings.forEach((ring, ringIndex) => {
      ring.forEach((_, pointIndex) => {
        const key = getSurfaceEdgeKey(surface, ringIndex, pointIndex);
        edgeUsage.set(key, (edgeUsage.get(key) || 0) + 1);
      });
    });
  });

  return (
    <g
      className={`iso-preview ${expanded ? 'expanded' : ''} ${selected ? 'selected' : ''} ${transparent ? 'transparent' : ''} ${showGrid ? 'grid-on' : ''} ${showEdges ? 'edges-on' : ''}`}
      aria-label="3Dプレビュー"
      onClick={(event) => {
        event.stopPropagation();
        onSelect?.();
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onDoubleSelect();
      }}
    >
      <rect className="iso-preview-frame" x={box.x} y={box.y} width={box.width} height={box.height} rx="4" />
      {projectedSurfaces.map((surface, index) => (
        <g key={`${surface.className}-${index}`}>
          <path className={surface.className} d={surface.path} fillRule="evenodd" />
          {showEdges && surface.edge !== false ? surface.projectedRings.flatMap((ring, ringIndex) =>
            ring.map((point, pointIndex) => {
              const key = getSurfaceEdgeKey(surface, ringIndex, pointIndex);
              if (edgeUsage.get(key) !== 1) {
                return null;
              }
              const next = ring[(pointIndex + 1) % ring.length];
              return (
                <line
                  key={`${index}-${ringIndex}-${pointIndex}`}
                  className="iso-preview-outline-edge"
                  x1={point.sx}
                  y1={point.sy}
                  x2={next.sx}
                  y2={next.sy}
                />
              );
            }),
          ) : null}
        </g>
      ))}
      <text x={box.x + box.width / 2} y={box.labelY}>3D preview</text>
    </g>
  );
}

function getFaceTransform(face, full) {
  if (full) {
    return 'translate(43 14) scale(2)';
  }
  if (face === 'top') {
    return 'translate(62 6)';
  }
  if (face === 'right') {
    return 'translate(198 142)';
  }
  return 'translate(62 142)';
}

function getShapeBounds2D(shape) {
  if (shape.type === 'circle') {
    return {
      minX: shape.x - shape.r,
      maxX: shape.x + shape.r,
      minY: shape.y - shape.r,
      maxY: shape.y + shape.r,
      width: shape.r * 2,
      height: shape.r * 2,
      centerX: shape.x,
      centerY: shape.y,
    };
  }
  if (shape.type === 'internalGear') {
    const { outerRadius } = getInternalGearRadii(shape);
    return {
      minX: shape.x - outerRadius,
      maxX: shape.x + outerRadius,
      minY: shape.y - outerRadius,
      maxY: shape.y + outerRadius,
      width: outerRadius * 2,
      height: outerRadius * 2,
      centerX: shape.x,
      centerY: shape.y,
    };
  }
  if (shape.type === 'gear') {
    const { outerRadius } = getGearRadii(shape);
    return {
      minX: shape.x - outerRadius,
      maxX: shape.x + outerRadius,
      minY: shape.y - outerRadius,
      maxY: shape.y + outerRadius,
      width: outerRadius * 2,
      height: outerRadius * 2,
      centerX: shape.x,
      centerY: shape.y,
    };
  }
  if (shape.type === 'rack') {
    const dimensions = getRackGearDimensions(shape);
    return {
      minX: shape.x,
      maxX: shape.x + dimensions.width,
      minY: shape.y,
      maxY: shape.y + dimensions.height,
      width: dimensions.width,
      height: dimensions.height,
      centerX: shape.x + dimensions.width / 2,
      centerY: shape.y + dimensions.height / 2,
    };
  }

  return {
    minX: shape.x,
    maxX: shape.x + shape.w,
    minY: shape.y,
    maxY: shape.y + shape.h,
    width: shape.w,
    height: shape.h,
    centerX: shape.x + shape.w / 2,
    centerY: shape.y + shape.h / 2,
  };
}

function formatDimensionValue(value) {
  return Number(Math.max(0, value).toFixed(1)).toString();
}

function getDimensionTextPoint(start, end, offset = 0) {
  const horizontal = Math.abs(start.y - end.y) < 0.001;
  if (horizontal) {
    return {
      x: (start.x + end.x) / 2,
      y: start.y - 2 + offset,
      rotate: null,
    };
  }
  return {
    x: start.x + 3 + offset,
    y: (start.y + end.y) / 2,
    rotate: null,
  };
}

function DimensionArrow({ start, end, value, className = '' }) {
  const textPoint = getDimensionTextPoint(start, end);
  if (value <= 0.001) {
    return null;
  }

  return (
    <g className={`dimension-line ${className}`}>
      <line
        x1={start.x}
        y1={start.y}
        x2={end.x}
        y2={end.y}
        markerStart="url(#dimension-arrow)"
        markerEnd="url(#dimension-arrow)"
      />
      <text x={textPoint.x} y={textPoint.y}>
        {formatDimensionValue(value)}
      </text>
    </g>
  );
}

function ShapeDimensions({ shape, outerBounds }) {
  if (!outerBounds) {
    return null;
  }

  const bounds = getShapeBounds2D(shape);
  const topY = clampValue(bounds.minY - 7, 7, 113);
  const bottomY = clampValue(bounds.maxY + 7, 7, 113);
  const leftX = clampValue(bounds.minX - 7, 7, 113);
  const rightX = clampValue(bounds.maxX + 7, 7, 113);
  const centerX = clampValue(bounds.centerX, 7, 113);
  const centerY = clampValue(bounds.centerY, 7, 113);

  const distanceArrows = [
    {
      key: 'left',
      start: { x: outerBounds.minX, y: topY },
      end: { x: bounds.minX, y: topY },
      value: bounds.minX - outerBounds.minX,
    },
    {
      key: 'right',
      start: { x: bounds.maxX, y: topY },
      end: { x: outerBounds.maxX, y: topY },
      value: outerBounds.maxX - bounds.maxX,
    },
    {
      key: 'top',
      start: { x: leftX, y: outerBounds.minY },
      end: { x: leftX, y: bounds.minY },
      value: bounds.minY - outerBounds.minY,
    },
    {
      key: 'bottom',
      start: { x: rightX, y: bounds.maxY },
      end: { x: rightX, y: outerBounds.maxY },
      value: outerBounds.maxY - bounds.maxY,
    },
  ];

  const shapeSizeArrows = shape.mode === 'add'
    ? [
        {
          key: 'width',
          start: { x: bounds.minX, y: bottomY },
          end: { x: bounds.maxX, y: bottomY },
          value: bounds.width,
          className: 'shape-size',
        },
        {
          key: 'height',
          start: { x: centerX, y: bounds.minY },
          end: { x: centerX, y: bounds.maxY },
          value: bounds.height,
          className: 'shape-size',
        },
      ]
    : [];

  return (
    <g className={`shape-dimensions ${shape.mode}`}>
      {[...distanceArrows, ...shapeSizeArrows].map((arrow) => (
        <DimensionArrow
          key={arrow.key}
          start={arrow.start}
          end={arrow.end}
          value={arrow.value}
          className={arrow.className}
        />
      ))}
    </g>
  );
}

function FacePlan({
  face,
  active,
  full,
  shapes,
  constraint,
  axisReadiness,
  showAllDimensions,
  selectedId,
  onSelect,
  onFaceSelect,
  onFaceDoubleSelect,
}) {
  const outerBounds = getBooleanPolygonBounds(getFaceBooleanPolygons(shapes));
  const dimensionShapes = shapes.filter((shape) => showAllDimensions || shape.showDimensions);

  return (
    <g
      className={`face-plan face-${face} ${active ? 'active' : ''} ${full ? 'full' : ''}`}
      transform={getFaceTransform(face, full)}
      role="button"
      tabIndex="0"
      aria-label={FACE_LABELS[face]}
      onClick={() => {
        onFaceSelect(face);
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onFaceDoubleSelect(face);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onFaceSelect(face);
        }
      }}
    >
      <rect className="face-plan-bg" width="120" height="120" rx="2" />
      <rect className="face-plan-surface" width="120" height="120" />
      <rect className="face-plan-grid" width="120" height="120" />
      <line x1="0" y1="60" x2="120" y2="60" className="face-axis" />
      <line x1="60" y1="0" x2="60" y2="120" className="face-axis" />
      <rect
        className={`final-face face-${face}`}
        width="120"
        height="120"
        mask={`url(#body-mask-${face})`}
      />
      <ConstraintOverlay constraint={constraint} />
      {shapes.map((shape) => (
        <FinalOutline key={`outline-${shape.id}`} shape={shape} />
      ))}
      {shapes.map((shape) => (
        <ShapePreview
          key={shape.id}
          shape={shape}
          selected={shape.id === selectedId}
          onSelect={() => onSelect(shape.id)}
        />
      ))}
      {dimensionShapes.map((shape) => (
        <ShapeDimensions key={`dimensions-${shape.id}`} shape={shape} outerBounds={outerBounds} />
      ))}
      <text className="face-plan-label" x="60" y="112">{FACE_LABELS[face]}</text>
      <ProjectionReadinessIndicator axis="x" readiness={axisReadiness?.x} />
      <ProjectionReadinessIndicator axis="y" readiness={axisReadiness?.y} />
    </g>
  );
}

function getProjectionReadinessLabel(readiness) {
  const dimension = DIMENSION_LABELS[readiness.dimension];
  const counterpart = FACE_LABELS[readiness.counterpartFace];
  if (readiness.status === 'pass') {
    return `${dimension}: ${counterpart}の固定範囲と両端が一致しています`;
  }
  if (readiness.reason === 'missing-shape') {
    return `${dimension}: この面にadd外形がありません`;
  }
  if (readiness.status === 'fail') {
    return `${dimension}: ${counterpart}の固定範囲と両端を合わせてください`;
  }
  return `${dimension}: 補助表示なし`;
}

function ProjectionReadinessIndicator({ axis, readiness }) {
  if (!readiness || readiness.status === 'hidden') {
    return null;
  }

  const horizontal = axis === 'x';
  const markerValue = clampValue(
    readiness.actualRange?.max ?? readiness.expectedRange?.max ?? 60,
    4,
    116,
  );
  const statusX = horizontal ? markerValue : 129;
  const statusY = horizontal ? 129 : markerValue;
  const label = getProjectionReadinessLabel(readiness);
  const showActual = Boolean(readiness.actualRange);

  return (
    <g
      className={`projection-readiness ${horizontal ? 'horizontal' : 'vertical'} ${readiness.status}`}
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      <ProjectionRangeArrow axis={axis} range={readiness.expectedRange} kind="expected" />
      {showActual ? (
        <ProjectionRangeArrow axis={axis} range={readiness.actualRange} kind={`actual ${readiness.status}`} />
      ) : null}
      {showActual && readiness.status === 'pass' ? (
        <circle className="projection-readiness-pass" cx={statusX} cy={statusY} r="4.2" />
      ) : null}
      {showActual && readiness.status === 'fail' ? (
        <g className="projection-readiness-fail">
          <line x1={statusX - 3.2} y1={statusY - 3.2} x2={statusX + 3.2} y2={statusY + 3.2} />
          <line x1={statusX + 3.2} y1={statusY - 3.2} x2={statusX - 3.2} y2={statusY + 3.2} />
        </g>
      ) : null}
    </g>
  );
}

function ProjectionRangeArrow({ axis, range, kind }) {
  if (!range) {
    return null;
  }

  const min = clampValue(range.min, 0, 120);
  const max = clampValue(range.max, 0, 120);
  const headSize = Math.min(3, Math.max(1, (max - min) / 3));
  if (axis === 'x') {
    return (
      <g className={`projection-range-arrow ${kind}`}>
        <line x1={min} y1="124" x2={max} y2="124" />
        <polyline points={`${min + headSize},${124 - headSize} ${min},124 ${min + headSize},${124 + headSize}`} />
        <polyline points={`${max - headSize},${124 - headSize} ${max},124 ${max - headSize},${124 + headSize}`} />
      </g>
    );
  }

  return (
    <g className={`projection-range-arrow ${kind}`}>
      <line x1="124" y1={min} x2="124" y2={max} />
      <polyline points={`${124 - headSize},${min + headSize} 124,${min} ${124 + headSize},${min + headSize}`} />
      <polyline points={`${124 - headSize},${max - headSize} 124,${max} ${124 + headSize},${max - headSize}`} />
    </g>
  );
}

function ConstraintOverlay({ constraint }) {
  const overlays = [];
  if (constraint?.constrainedX) {
    overlays.push(...getOutsideXRects(constraint));
  }
  if (constraint?.constrainedY) {
    overlays.push(...getOutsideYRects(constraint));
  }

  return overlays.map((rect, index) => (
    <rect
      key={`${rect.type}-${index}`}
      className={`constraint-mask ${rect.type}`}
      x={rect.x}
      y={rect.y}
      width={rect.width}
      height={rect.height}
    />
  ));
}

function getOutsideXRects(bounds) {
  return [
    { type: 'x', x: 0, y: 0, width: bounds.minX, height: 120 },
    { type: 'x', x: bounds.maxX, y: 0, width: 120 - bounds.maxX, height: 120 },
  ].filter((rect) => rect.width > 0.01);
}

function getOutsideYRects(bounds) {
  return [
    { type: 'y', x: 0, y: 0, width: 120, height: bounds.minY },
    { type: 'y', x: 0, y: bounds.maxY, width: 120, height: 120 - bounds.maxY },
  ].filter((rect) => rect.height > 0.01);
}

function ringToSvgPath(ring) {
  if (!ring.length) {
    return '';
  }
  return `M ${ring.map(([x, y]) => `${x} ${y}`).join(' L ')} Z`;
}

function getGearBoreSvgPath(shape) {
  const { boreRadius } = getGearRadii(shape);
  if (boreRadius <= 0) {
    return '';
  }
  return [
    `M ${shape.x - boreRadius} ${shape.y}`,
    `A ${boreRadius} ${boreRadius} 0 1 0 ${shape.x + boreRadius} ${shape.y}`,
    `A ${boreRadius} ${boreRadius} 0 1 0 ${shape.x - boreRadius} ${shape.y}`,
    'Z',
  ].join(' ');
}

function getGearBodySvgPath(shape) {
  return `${ringToSvgPath(getGearOutlineRing(shape))} ${getGearBoreSvgPath(shape)}`.trim();
}

function getInternalGearBodySvgPath(shape) {
  return `${ringToSvgPath(getInternalGearOuterRing(shape))} ${ringToSvgPath(getInternalGearInnerRing(shape))}`;
}

function MaskShape({ shape }) {
  const fill = shape.mode === 'cut' ? 'black' : 'white';
  if (shape.type === 'circle') {
    return <circle cx={shape.x} cy={shape.y} r={shape.r} fill={fill} />;
  }
  if (shape.type === 'gear') {
    const { boreRadius } = getGearRadii(shape);
    return (
      <>
        <path d={ringToSvgPath(getGearOutlineRing(shape))} fill={fill} />
        {boreRadius > 0 ? <circle cx={shape.x} cy={shape.y} r={boreRadius} fill="black" /> : null}
      </>
    );
  }
  if (shape.type === 'internalGear') {
    return (
      <>
        <path d={ringToSvgPath(getInternalGearOuterRing(shape))} fill={fill} />
        <path d={ringToSvgPath(getInternalGearInnerRing(shape))} fill="black" />
      </>
    );
  }
  if (shape.type === 'rack') {
    return <path d={ringToSvgPath(getRackGearOutlineRing(shape))} fill={fill} />;
  }

  return (
    <rect
      x={shape.x}
      y={shape.y}
      width={shape.w}
      height={shape.h}
      rx="1.4"
      fill={fill}
    />
  );
}

function FinalOutline({ shape }) {
  const className = `final-outline face-${normalizeFace(shape.face)}`;
  if (shape.type === 'circle') {
    return (
      <circle
        className={className}
        cx={shape.x}
        cy={shape.y}
        r={shape.r}
      />
    );
  }
  if (shape.type === 'gear') {
    const { boreRadius } = getGearRadii(shape);
    return (
      <>
        <path className={className} d={ringToSvgPath(getGearOutlineRing(shape))} />
        {boreRadius > 0 ? (
          <circle className={className} cx={shape.x} cy={shape.y} r={boreRadius} />
        ) : null}
      </>
    );
  }
  if (shape.type === 'internalGear') {
    return (
      <>
        <path className={className} d={ringToSvgPath(getInternalGearOuterRing(shape))} />
        <path className={className} d={ringToSvgPath(getInternalGearInnerRing(shape))} />
      </>
    );
  }
  if (shape.type === 'rack') {
    return <path className={className} d={ringToSvgPath(getRackGearOutlineRing(shape))} />;
  }

  return (
    <rect
      className={className}
      x={shape.x}
      y={shape.y}
      width={shape.w}
      height={shape.h}
      rx="1.4"
    />
  );
}

function ShapePreview({ shape, selected, onSelect }) {
  const className = `shape-preview ${shape.mode} face-${normalizeFace(shape.face)} ${selected ? 'selected' : ''}`;
  function handleSelect(event) {
    event.stopPropagation();
    onSelect();
  }

  function handleDoubleClick(event) {
    event.stopPropagation();
  }

  if (shape.type === 'circle') {
    return (
      <circle
        className={className}
        cx={shape.x}
        cy={shape.y}
        r={shape.r}
        onClick={handleSelect}
        onDoubleClick={handleDoubleClick}
      />
    );
  }
  if (shape.type === 'gear') {
    return (
      <path
        className={className}
        d={getGearBodySvgPath(shape)}
        fillRule="evenodd"
        onClick={handleSelect}
        onDoubleClick={handleDoubleClick}
      />
    );
  }
  if (shape.type === 'internalGear') {
    return (
      <path
        className={className}
        d={getInternalGearBodySvgPath(shape)}
        fillRule="evenodd"
        onClick={handleSelect}
        onDoubleClick={handleDoubleClick}
      />
    );
  }
  if (shape.type === 'rack') {
    return (
      <path
        className={className}
        d={ringToSvgPath(getRackGearOutlineRing(shape))}
        onClick={handleSelect}
        onDoubleClick={handleDoubleClick}
      />
    );
  }

  return (
    <rect
      className={className}
      x={shape.x}
      y={shape.y}
      width={shape.w}
      height={shape.h}
      rx="1.4"
      onClick={handleSelect}
      onDoubleClick={handleDoubleClick}
    />
  );
}

function ShapeEditor({
  editorRef,
  shape,
  index,
  total,
  selected,
  locked,
  constraint,
  onSelect,
  onChange,
  onMove,
  onRemove,
}) {
  const limits = getShapeControlLimits(shape, constraint, locked);

  return (
    <article ref={editorRef} className={`shape-card ${selected ? 'selected' : ''}`}>
      <header className="shape-card-top">
        <button type="button" className="shape-title" onClick={onSelect}>
          {getShapeLabel(shape)}
        </button>
        <select
          className="mode-select"
          value={shape.mode}
          onChange={(event) => onChange({ mode: event.target.value })}
          aria-label={`${getShapeLabel(shape)} operation`}
          disabled={shape.type === 'gear' || shape.type === 'rack' || shape.type === 'internalGear'}
          title={shape.type === 'gear' || shape.type === 'rack' || shape.type === 'internalGear' ? 'ギヤ形状はadd専用です' : undefined}
        >
          <option value="add">add</option>
          <option value="cut">cut</option>
        </select>
        <button
          type="button"
          className={`dimension-toggle ${shape.showDimensions ? 'active-toggle' : ''}`}
          aria-pressed={Boolean(shape.showDimensions)}
          onClick={() => onChange({ showDimensions: !shape.showDimensions })}
        >
          寸法
        </button>
        <div className="shape-actions">
          <button type="button" onClick={() => onMove(shape.id, -1)} disabled={index === 0}>
            ↑
          </button>
          <button type="button" onClick={() => onMove(shape.id, 1)} disabled={index === total - 1}>
            ↓
          </button>
          <button type="button" className="danger" onClick={() => onRemove(shape.id)}>
            削除
          </button>
        </div>
      </header>

      <div className={`shape-control-grid ${shape.type === 'gear' || shape.type === 'rack' || shape.type === 'internalGear' ? 'gear-controls' : ''}`}>
        <ControlField
          axis="x"
          label="X"
          value={shape.x}
          min={limits.x.min}
          max={limits.x.max}
          onChange={(x) => onChange({ x })}
        />
        <ControlField
          axis="y"
          label="Y"
          value={shape.y}
          min={limits.y.min}
          max={limits.y.max}
          invert
          onChange={(y) => onChange({ y })}
        />
        {shape.type === 'rect' ? (
          <>
            <ControlField
              axis="x"
              label="W"
              value={shape.w}
              min={limits.w.min}
              max={limits.w.max}
              onChange={(w) => onChange({ w })}
            />
            <ControlField
              axis="y"
              label="H"
              value={shape.h}
              min={limits.h.min}
              max={limits.h.max}
              onChange={(h) => onChange({ h })}
            />
          </>
        ) : shape.type === 'circle' ? (
          <>
            <ControlField
              axis="x"
              label="R"
              value={shape.r}
              min={limits.r.min}
              max={limits.r.max}
              onChange={(r) => onChange({ r })}
            />
            <div className="control-field empty" aria-hidden="true" />
          </>
        ) : shape.type === 'gear' ? (
          <>
            <ControlField
              axis="x"
              label="M"
              value={shape.module}
              min={limits.module.min}
              max={limits.module.max}
              step={0.5}
              onChange={(moduleValue) => onChange({ module: moduleValue })}
            />
            <ControlField
              axis="x"
              label="歯数"
              value={shape.teeth}
              min={limits.teeth.min}
              max={limits.teeth.max}
              onChange={(teeth) => onChange({ teeth: Math.round(teeth) })}
            />
            <ControlField
              axis="x"
              label="穴径"
              value={shape.bore}
              min={limits.bore.min}
              max={limits.bore.max}
              onChange={(bore) => onChange({ bore })}
            />
          </>
        ) : shape.type === 'rack' ? (
          <>
            <ControlField
              axis="x"
              label="M"
              value={shape.module}
              min={limits.module.min}
              max={limits.module.max}
              step={0.5}
              onChange={(moduleValue) => onChange({ module: moduleValue })}
            />
            <ControlField
              axis="x"
              label="歯数"
              value={shape.teeth}
              min={limits.teeth.min}
              max={limits.teeth.max}
              step={1}
              onChange={(teeth) => onChange({ teeth: Math.round(teeth) })}
            />
            <ControlField
              axis="y"
              label="歯先高"
              value={shape.height}
              min={limits.height.min}
              max={limits.height.max}
              step={1}
              onChange={(height) => onChange({ height: Math.round(height) })}
            />
          </>
        ) : (
          <>
            <ControlField
              axis="x"
              label="M"
              value={shape.module}
              min={limits.module.min}
              max={limits.module.max}
              step={0.5}
              onChange={(moduleValue) => onChange({ module: moduleValue })}
            />
            <ControlField
              axis="x"
              label="歯数"
              value={shape.teeth}
              min={limits.teeth.min}
              max={limits.teeth.max}
              step={1}
              onChange={(teeth) => onChange({ teeth: Math.round(teeth) })}
            />
            <ControlField
              axis="x"
              label="外径"
              value={shape.outerDiameter}
              min={limits.outerDiameter.min}
              max={limits.outerDiameter.max}
              step={0.5}
              onChange={(outerDiameter) => onChange({ outerDiameter })}
            />
          </>
        )}
      </div>
    </article>
  );
}

function RotationControls({
  rotation,
  transparent,
  showGrid,
  showEdges,
  onChange,
  onReset,
  onView,
  onTransparencyChange,
  onGridChange,
  onEdgesChange,
}) {
  return (
    <section className="rotation-panel" aria-label="3D rotation controls">
      <div className="rotation-header">
        <span>3D回転</span>
      </div>
      <div className="rotation-grid">
        {['x', 'y', 'z'].map((axis) => (
          <label key={axis} className="rotation-field">
            <span>{axis.toUpperCase()}</span>
            <input
              type="range"
              min="-180"
              max="180"
              step="1"
              value={rotation[axis]}
              onChange={(event) => onChange(axis, Number(event.target.value))}
            />
            <NumberField
              label={`${axis} rotation`}
              value={rotation[axis]}
              min={-180}
              max={180}
              compact
              onChange={(value) => onChange(axis, value)}
            />
          </label>
        ))}
      </div>
      <div className="rotation-actions">
        <button type="button" className="rotation-reset" onClick={onReset}>
          初期角度
        </button>
        <div className="view-net" aria-label="3D view presets">
          <button type="button" className="view-top" onClick={() => onView('top')}>上面</button>
          <button type="button" className="view-left" onClick={() => onView('left')}>左側面</button>
          <button type="button" className="view-front" onClick={() => onView('front')}>正面</button>
          <button type="button" className="view-right" onClick={() => onView('right')}>右側面</button>
          <button type="button" className="view-bottom" onClick={() => onView('bottom')}>底面</button>
          <button type="button" className="view-back" onClick={() => onView('back')}>背面</button>
        </div>
        <label className="transparent-toggle">
          <input
            type="checkbox"
            checked={transparent}
            onChange={(event) => onTransparencyChange(event.target.checked)}
          />
          <span>透過</span>
        </label>
        <label className="grid-toggle">
          <input
            type="checkbox"
            checked={showGrid}
            onChange={(event) => onGridChange(event.target.checked)}
          />
          <span>グリッド</span>
        </label>
        <label className="edge-toggle">
          <input
            type="checkbox"
            checked={showEdges}
            onChange={(event) => onEdgesChange(event.target.checked)}
          />
          <span>エッジ</span>
        </label>
      </div>
    </section>
  );
}

function ControlField({ axis, label, value, min, max, step = 1, invert = false, onChange }) {
  const controlMin = ceilToModelPrecision(min);
  const controlMax = Math.max(controlMin, floorToModelPrecision(max));
  const controlValue = roundToModelPrecision(clampValue(value, controlMin, controlMax));
  const sliderScale = createDiscreteSliderScale(controlMin, controlMax, step);
  const controlPosition = sliderScale.positionFor(controlValue);
  const sliderValue = invert ? sliderScale.maxPosition - controlPosition : controlPosition;

  function handleSliderChange(event) {
    const nextPosition = Number(event.target.value);
    const controlNextPosition = invert
      ? sliderScale.maxPosition - nextPosition
      : nextPosition;
    onChange(sliderScale.valueAt(controlNextPosition));
  }

  return (
    <label className={`control-field ${axis === 'y' ? 'axis-y' : 'axis-x'}`}>
      <span>{label}</span>
      <input
        type="range"
        min="0"
        max={sliderScale.maxPosition}
        step="1"
        value={sliderValue}
        onChange={handleSliderChange}
      />
      <NumberField
        label={`${label} value`}
        value={controlValue}
        min={controlMin}
        max={controlMax}
        step={step}
        compact
        onChange={onChange}
      />
    </label>
  );
}

function NumberField({ label, value, min, max, step = 1, compact = false, onChange }) {
  const normalizedMin = ceilToModelPrecision(min);
  const normalizedMax = Math.max(normalizedMin, floorToModelPrecision(max));
  const normalizedValue = roundToModelPrecision(clampValue(value, normalizedMin, normalizedMax));
  return (
    <label className={compact ? 'number-field compact' : 'number-field'}>
      <span>{label}</span>
      <input
        type="number"
        min={normalizedMin}
        max={normalizedMax}
        step={step}
        value={normalizedValue}
        onChange={(event) => onChange(roundToModelPrecision(Number(event.target.value) || 0))}
      />
    </label>
  );
}

createRoot(document.getElementById('root')).render(<App />);
