import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import earcut from 'earcut';
import polygonClipping from 'polygon-clipping';
import './style.css';

const STORAGE_KEY = 'oshidasumaho-cad-document-v1';
const SAVED_PARTS_KEY = 'oshidasumaho-cad-saved-parts-v1';
const ASSEMBLY_STORAGE_KEY = 'oshidasumaho-cad-assembly-v1';
const APP_VERSION = 'proto-2026-06-02-09';
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
    x: clampValue(Number(position?.x ?? 0), -120, 120),
    y: clampValue(Number(position?.y ?? 0), -120, 120),
    z: clampValue(Number(position?.z ?? 0), -120, 120),
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
    return saved ? normalizeDocument(JSON.parse(saved)) : normalizeDocument(initialDocument);
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
  return `${shape.type === 'rect' ? 'Rect' : 'Circle'} ${shape.id}`;
}

function clampRangeValue(value) {
  return Math.min(120, Math.max(0, value));
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
  const normalizedFace = normalizeFace(face);
  const sourceConstraint = getLockConstraintForBounds(faceBounds[normalizedFace]);
  if (!sourceConstraint) {
    return false;
  }

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

  return FACE_ORDER.every((targetFace) =>
    areBoundsWithinConstraint(faceBounds[targetFace], lockedConstraints[targetFace]),
  );
}

function clampValue(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function constrainShape(shape, constraint) {
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

function pointInShape(shape, x, y) {
  if (shape.type === 'circle') {
    return ((x - shape.x) ** 2) + ((y - shape.y) ** 2) <= shape.r ** 2;
  }

  return x >= shape.x && x <= shape.x + shape.w && y >= shape.y && y <= shape.y + shape.h;
}

function pointInFaceSolid(shapes, face, x, y) {
  const faceShapes = shapes.filter((shape) => normalizeFace(shape.face) === face);
  return faceShapes.reduce((solid, shape) => {
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
      return normalizeMultiPolygon(
        result.length ? polygonClipping.union(result, shapePolygon) : shapePolygon,
      );
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
  return (documentData.partName || 'oshidasumaho-cad-part').replace(/[\\/:*?"<>|]+/g, '-');
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
  const centerU = shape.type === 'circle' ? shape.x : shape.x + shape.w / 2;
  const centerV = shape.type === 'circle' ? shape.y : shape.y + shape.h / 2;

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
  const controlPanelRef = useRef(null);
  const editorRefs = useRef(new Map());
  const assemblyRefs = useRef(new Map());

  const selectedShape = document.shapes.find((shape) => shape.id === selectedId);
  const activeFace = normalizeFace(document.activeFace);
  const activeShapes = document.shapes.filter((shape) => normalizeFace(shape.face) === activeFace);
  const faceBounds = useMemo(() => getAllFaceBounds(document.shapes), [document.shapes]);
  const lockedConstraints = useMemo(() => getAllLockedConstraints(document), [document]);
  const areaLockAvailability = useMemo(
    () => Object.fromEntries(FACE_ORDER.map((face) => [face, canLockFace(document, face, faceBounds)])),
    [document, faceBounds],
  );
  const previewDimensions = useMemo(() => getLockedPreviewDimensions(document), [document]);
  const stlResolutionMax = useMemo(() => getMeshResolutionMax(previewDimensions, STL_MESH_OPTIONS), [previewDimensions]);
  const showing3DControls = !outputOpen && Boolean((document.viewMode === '3d' || preview3DSelected) && previewDimensions);
  const showingFaceControls = !showing3DControls && !outputOpen;
  const jsonText = useMemo(() => JSON.stringify(document, null, 2), [document]);
  const selectedAssemblyInstance = assembly.instances.find((instance) => instance.id === selectedAssemblyId);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(document));
  }, [document]);

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
          if (nextShape.mode === 'cut' || !hasAreaConstraint(constraint)) {
            return nextShape;
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
    setDocument((current) => {
      const id = getNextId(current.shapes);
      const face = normalizeFace(current.activeFace);
      const shapeBase =
        type === 'rect'
          ? { id, type: 'rect', x: 18, y: 16, w: 42, h: 28, mode: 'add', face }
          : { id, type: 'circle', x: 44, y: 32, r: 3, mode: 'cut', face };
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
      if (nextLockValue && !canLockFace(current, normalizedFace)) {
        return current;
      }

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
    const fileNameBase = getOutputBaseName(document);
    const url = URL.createObjectURL(blob);
    const anchor = window.document.createElement('a');
    anchor.href = url;
    anchor.download = `${fileNameBase}.${extension}`;
    anchor.click();
    URL.revokeObjectURL(url);
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
          />
        )}
      </section>

      <section ref={controlPanelRef} className="control-panel" aria-label="CAD controls">
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
            onFormatChange={setOutputFormat}
            onPartNameChange={updatePartName}
            onSavedPartSelect={setLoadPartId}
            onLoadPart={loadPart}
            onDeleteSavedPart={deleteSavedPart}
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
              <button type="button" onClick={onAssemblyOpen}>アセンブリ(開発中)</button>
              <button type="button" onClick={onReset}>画面リセット</button>
            </div>
          ) : null}
        </div>
      </div>
      <svg className="tri-view" viewBox="0 0 378 268" role="img" aria-label="3面配置図">
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
  onFormatChange,
  onPartNameChange,
  onSavedPartSelect,
  onLoadPart,
  onDeleteSavedPart,
  onCopyJson,
  onSaveJson,
  onSaveWeb,
  onMeshResolutionChange,
  onSaveStl,
  onSaveStep,
}) {
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
        <HelpPanel />
      ) : null}
    </section>
  );
}

function HelpPanel() {
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
        <li>図形をタップすると、その図形の編集UIへ移動します。</li>
        <li>図形以外をタップすると、その面の先頭へ戻ります。</li>
        <li>面をダブルタップすると、その面だけを拡大表示します。もう一度ダブルタップすると3面図へ戻ります。</li>
        <li>3Dプレビューをタップすると、回転・透過・グリッド・エッジの表示を調整できます。</li>
        <li>3Dプレビューをダブルタップすると、3D表示を拡大します。</li>
      </ul>
      <h2>保存</h2>
      <ul>
        <li>JSONは現在の編集データです。ファイル保存とweb保存ができます。</li>
        <li>STLはスライサー向けのメッシュとして保存します。</li>
        <li>STEPはOpenCascadeでCAD向けのB-repとして保存します。</li>
      </ul>
      <h2>ロックのヒント</h2>
      <ul>
        <li>ロックは、その面の外形範囲を他の面へ反映して、3Dとして矛盾しない配置範囲を固定する機能です。</li>
        <li>ロックできない時は、他の面の図形が灰色の禁止エリアにはみ出していないか確認してください。</li>
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
    return 'translate(326 190)';
  }
  if (face === 'front') {
    return 'translate(6 190)';
  }
  return 'translate(6 54)';
}

function AreaLockButton({ face, full, locked, disabled, onToggle }) {
  return (
    <g
      className={`area-lock-button face-${face} ${locked ? 'locked' : ''} ${disabled ? 'disabled' : ''}`}
      transform={getAreaLockTransform(face, full)}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-label={`${FACE_LABELS[face]} エリアロック`}
      onClick={(event) => {
        event.stopPropagation();
        if (!disabled) {
          onToggle(face);
        }
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
      }}
      onKeyDown={(event) => {
        if ((event.key === 'Enter' || event.key === ' ') && !disabled) {
          event.preventDefault();
          onToggle(face);
        }
      }}
    >
      <rect width="50" height="24" rx="5" />
      <text x="25" y="16">エリア</text>
      <text x="43" y="16">🔒</text>
    </g>
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

function MaskShape({ shape }) {
  const fill = shape.mode === 'cut' ? 'black' : 'white';
  if (shape.type === 'circle') {
    return <circle cx={shape.x} cy={shape.y} r={shape.r} fill={fill} />;
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

      <div className="shape-control-grid">
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
        ) : (
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

function ControlField({ axis, label, value, min, max, invert = false, onChange }) {
  const sliderValue = invert ? max - value + min : value;

  function handleSliderChange(event) {
    const nextValue = Number(event.target.value);
    onChange(invert ? max - nextValue + min : nextValue);
  }

  return (
    <label className={`control-field ${axis === 'y' ? 'axis-y' : 'axis-x'}`}>
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step="1"
        value={sliderValue}
        onChange={handleSliderChange}
      />
      <NumberField
        label={`${label} value`}
        value={value}
        min={min}
        max={max}
        compact
        onChange={onChange}
      />
    </label>
  );
}

function NumberField({ label, value, min, max, compact = false, onChange }) {
  return (
    <label className={compact ? 'number-field compact' : 'number-field'}>
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step="1"
        value={value}
        onChange={(event) => onChange(Number(event.target.value) || 0)}
      />
    </label>
  );
}

createRoot(document.getElementById('root')).render(<App />);
