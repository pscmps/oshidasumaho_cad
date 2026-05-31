import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import earcut from 'earcut';
import polygonClipping from 'polygon-clipping';
import './style.css';

const STORAGE_KEY = 'oshidasumaho-cad-document-v1';
const SAVED_PARTS_KEY = 'oshidasumaho-cad-saved-parts-v1';
const APP_VERSION = 'proto-2026-05-31-plan-29';
const SOLID_PREVIEW_STEPS = 18;
const CIRCLE_MESH_SEGMENTS = 64;
const STL_VOXEL_CELL_SIZE = 0.5;
const STL_VOXEL_MAX_AXIS_STEPS = 180;
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
  shapes: [
    { id: 1, type: 'rect', x: 10, y: 10, w: 70, h: 42, mode: 'add', face: 'top' },
    { id: 2, type: 'circle', x: 42, y: 31, r: 9, mode: 'cut', face: 'top' },
  ],
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
    shapes,
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

function getVoxelIndex(xIndex, yIndex, zIndex, stepCounts) {
  return (zIndex * stepCounts.y + yIndex) * stepCounts.x + xIndex;
}

function hasVoxelCell(cells, stepCounts, xIndex, yIndex, zIndex) {
  if (
    xIndex < 0 ||
    yIndex < 0 ||
    zIndex < 0 ||
    xIndex >= stepCounts.x ||
    yIndex >= stepCounts.y ||
    zIndex >= stepCounts.z
  ) {
    return false;
  }
  return cells[getVoxelIndex(xIndex, yIndex, zIndex, stepCounts)] === 1;
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

function pushTriangle(triangles, a, b, c) {
  const normal = getTriangleNormal(a, b, c);
  if (!normal) {
    return;
  }
  triangles.push({ normal, vertices: [a, b, c] });
}

function pushQuadTriangles(triangles, corners) {
  pushTriangle(triangles, corners[0], corners[1], corners[2]);
  pushTriangle(triangles, corners[0], corners[2], corners[3]);
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

function getStlVoxelGrid(dimensions) {
  const maxSize = Math.max(dimensions.width.size, dimensions.depth.size, dimensions.height.size);
  const targetCellSize = Math.max(STL_VOXEL_CELL_SIZE, maxSize / STL_VOXEL_MAX_AXIS_STEPS);
  const stepCounts = {
    x: Math.max(1, Math.ceil(dimensions.width.size / targetCellSize)),
    y: Math.max(1, Math.ceil(dimensions.depth.size / targetCellSize)),
    z: Math.max(1, Math.ceil(dimensions.height.size / targetCellSize)),
  };

  return {
    stepCounts,
    cell: {
      x: dimensions.width.size / stepCounts.x,
      y: dimensions.depth.size / stepCounts.y,
      z: dimensions.height.size / stepCounts.z,
    },
  };
}

function buildVoxelStlTriangles(shapes, dimensions) {
  const { stepCounts, cell } = getStlVoxelGrid(dimensions);
  const cells = new Uint8Array(stepCounts.x * stepCounts.y * stepCounts.z);
  const triangles = [];

  for (let xIndex = 0; xIndex < stepCounts.x; xIndex += 1) {
    for (let yIndex = 0; yIndex < stepCounts.y; yIndex += 1) {
      for (let zIndex = 0; zIndex < stepCounts.z; zIndex += 1) {
        const x = dimensions.width.min + (xIndex + 0.5) * cell.x;
        const depth = dimensions.depth.min + (yIndex + 0.5) * cell.y;
        const height = dimensions.height.min + (zIndex + 0.5) * cell.z;
        if (isVoxelSolid(shapes, dimensions, x, depth, height)) {
          cells[getVoxelIndex(xIndex, yIndex, zIndex, stepCounts)] = 1;
        }
      }
    }
  }

  const faceDefinitions = [
    { neighbor: [0, 0, 1], indexes: [4, 5, 6, 7] },
    { neighbor: [0, -1, 0], indexes: [0, 1, 5, 4] },
    { neighbor: [1, 0, 0], indexes: [1, 2, 6, 5] },
    { neighbor: [0, 0, -1], indexes: [0, 3, 2, 1] },
    { neighbor: [0, 1, 0], indexes: [3, 7, 6, 2] },
    { neighbor: [-1, 0, 0], indexes: [0, 4, 7, 3] },
  ];

  for (let xIndex = 0; xIndex < stepCounts.x; xIndex += 1) {
    for (let yIndex = 0; yIndex < stepCounts.y; yIndex += 1) {
      for (let zIndex = 0; zIndex < stepCounts.z; zIndex += 1) {
        if (!hasVoxelCell(cells, stepCounts, xIndex, yIndex, zIndex)) {
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
          if (hasVoxelCell(cells, stepCounts, xIndex + dx, yIndex + dy, zIndex + dz)) {
            return;
          }
          pushQuadTriangles(
            triangles,
            definition.indexes.map((index) => corners[index]),
          );
        });
      }
    }
  }

  return triangles;
}

function buildStlText(documentData, dimensions) {
  if (!dimensions) {
    return '';
  }
  const name = getOutputBaseName(documentData);
  const triangles = buildVoxelStlTriangles(documentData.shapes, dimensions);
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
  const [document, setDocument] = useState(loadDocument);
  const [selectedId, setSelectedId] = useState(document.shapes[0]?.id ?? null);
  const [preview3DSelected, setPreview3DSelected] = useState(false);
  const [fullPreviewFace, setFullPreviewFace] = useState(null);
  const [outputOpen, setOutputOpen] = useState(false);
  const [outputFormat, setOutputFormat] = useState('json');
  const [previewMenuOpen, setPreviewMenuOpen] = useState(false);
  const [savedParts, setSavedParts] = useState(loadSavedParts);
  const [partDialog, setPartDialog] = useState(null);
  const [saveName, setSaveName] = useState(document.partName ?? '');
  const [loadPartId, setLoadPartId] = useState('');
  const [stlSaving, setStlSaving] = useState(false);
  const controlPanelRef = useRef(null);
  const editorRefs = useRef(new Map());

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
  const showing3DControls = !outputOpen && Boolean((document.viewMode === '3d' || preview3DSelected) && previewDimensions);
  const showingFaceControls = !showing3DControls && !outputOpen;
  const jsonText = useMemo(() => JSON.stringify(document, null, 2), [document]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(document));
  }, [document]);

  useEffect(() => {
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
    setPartDialog(null);
  }

  function openSaveDialog() {
    setSaveName(document.partName ?? '');
    setPartDialog('save');
    setPreviewMenuOpen(false);
  }

  function openLoadDialog() {
    setLoadPartId(savedParts[0]?.id ?? '');
    setPartDialog('load');
    setPreviewMenuOpen(false);
  }

  function closePartDialog() {
    setPartDialog(null);
  }

  function savePart() {
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
    setPartDialog(null);
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
    setOutputOpen(false);
    setPartDialog(null);
    setPreviewMenuOpen(false);
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

  function openOutputPanel() {
    setOutputOpen(true);
    setOutputFormat('json');
    setSelectedId(null);
    setPreview3DSelected(false);
    setPreviewMenuOpen(false);
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
    const fileNameBase = getOutputBaseName(document);
    const blob = new Blob([text], { type });
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
      saveTextOutput(buildStlText(document, previewDimensions), 'stl', 'model/stl');
    } finally {
      setStlSaving(false);
    }
  }

  return (
    <main className="app-shell">
      <section className="viewer-panel" aria-label="CAD viewer">
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
          onReset={resetDocument}
          onOutputOpen={openOutputPanel}
          onSaveOpen={openSaveDialog}
          onLoadOpen={openLoadDialog}
        />
      </section>

      <section ref={controlPanelRef} className="control-panel" aria-label="CAD controls">
        {showingFaceControls ? (
          <header className="control-header">
            <div>
              <p className="eyebrow">Oshida Smartphone CAD</p>
              <h1>図形配置</h1>
            </div>
            <div className="header-actions">
              <button type="button" onClick={() => addShape('rect')}>+四角</button>
              <button type="button" onClick={() => addShape('circle')}>+円</button>
            </div>
          </header>
        ) : null}

        {showingFaceControls ? (
          <div className="document-controls">
            <div className="active-face-control" aria-label="配置面">
              <span>配置面</span>
              <strong className={`face-label face-${activeFace}`}>
                {FACE_LABELS[activeFace]}
              </strong>
            </div>
          </div>
        ) : null}

        {showingFaceControls ? (
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

        {showingFaceControls ? (
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

        {showing3DControls ? (
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

        {outputOpen ? (
          <OutputPanel
            format={outputFormat}
            jsonText={jsonText}
            stlReady={Boolean(previewDimensions)}
            stlSaving={stlSaving}
            onFormatChange={setOutputFormat}
            onCopyJson={() => copyTextOutput(jsonText)}
            onSaveJson={() => saveTextOutput(jsonText, 'json', 'application/json')}
            onSaveStl={saveStlOutput}
          />
        ) : null}
      </section>
      {partDialog === 'save' ? (
        <SavePartDialog
          name={saveName}
          onNameChange={setSaveName}
          onSave={savePart}
          onCancel={closePartDialog}
        />
      ) : null}
      {partDialog === 'load' ? (
        <LoadPartDialog
          savedParts={savedParts}
          selectedId={loadPartId}
          onSelect={setLoadPartId}
          onLoad={loadPart}
          onCancel={closePartDialog}
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
  onOutputOpen,
  onSaveOpen,
  onLoadOpen,
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
              <button type="button" onClick={onOutputOpen}>出力</button>
              <button type="button" onClick={onReset}>初期化</button>
            </div>
          ) : null}
        </div>
      </div>
      <svg className="tri-view" viewBox="0 0 378 268" role="img" aria-label="3面配置図">
        <defs>
          <pattern id="grid" width="10" height="10" patternUnits="userSpaceOnUse">
            <path d="M 10 0 L 0 0 0 10" fill="none" stroke="#d8dee9" strokeWidth="0.35" />
          </pattern>
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

function SavePartDialog({ name, onNameChange, onSave, onCancel }) {
  return (
    <div className="dialog-backdrop" role="presentation">
      <form
        className="part-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="部品保存"
        onSubmit={(event) => {
          event.preventDefault();
          onSave();
        }}
      >
        <header>
          <h2>保存</h2>
        </header>
        <label className="dialog-field">
          <span>名前</span>
          <input
            type="text"
            value={name}
            autoFocus
            onChange={(event) => onNameChange(event.target.value)}
          />
        </label>
        <div className="dialog-actions">
          <button type="submit" disabled={!name.trim()}>save</button>
          <button type="button" onClick={onCancel}>cancel</button>
        </div>
      </form>
    </div>
  );
}

function LoadPartDialog({ savedParts, selectedId, onSelect, onLoad, onCancel }) {
  const hasSavedParts = savedParts.length > 0;
  return (
    <div className="dialog-backdrop" role="presentation">
      <form
        className="part-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="部品呼び出し"
        onSubmit={(event) => {
          event.preventDefault();
          onLoad();
        }}
      >
        <header>
          <h2>呼び出し</h2>
        </header>
        <label className="dialog-field">
          <span>保存データ</span>
          <select
            value={selectedId}
            disabled={!hasSavedParts}
            onChange={(event) => onSelect(event.target.value)}
          >
            {hasSavedParts ? savedParts.map((part) => (
              <option key={part.id} value={part.id}>{part.name}</option>
            )) : (
              <option value="">保存データなし</option>
            )}
          </select>
        </label>
        <div className="dialog-actions">
          <button type="submit" disabled={!hasSavedParts || !selectedId}>load</button>
          <button type="button" onClick={onCancel}>cancel</button>
        </div>
      </form>
    </div>
  );
}

function OutputPanel({
  format,
  jsonText,
  stlReady,
  stlSaving,
  onFormatChange,
  onCopyJson,
  onSaveJson,
  onSaveStl,
}) {
  return (
    <section className="output-panel" aria-label="出力">
      <header className="output-header">
        <div>
          <p className="eyebrow">Oshida Smartphone CAD</p>
          <h1>出力</h1>
        </div>
      </header>
      <div className="output-tabs" role="tablist" aria-label="出力形式">
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
      {format === 'json' ? (
        <div className="output-content">
          <div className="output-actions">
            <button type="button" onClick={onCopyJson}>コピー</button>
            <button type="button" onClick={onSaveJson}>保存</button>
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
            <div className="output-placeholder">
              STLは保存時にスライサー向けの閉じたメッシュで生成します。
            </div>
          </div>
        ) : (
          <div className="output-placeholder">
            3面をロックするとSTL出力できます。
          </div>
        )
      ) : null}
      {format === 'step' ? (
        <div className="output-placeholder">
          STEP 出力は未実装です。
        </div>
      ) : (
        null
      )}
    </section>
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

function FacePlan({
  face,
  active,
  full,
  shapes,
  constraint,
  selectedId,
  onSelect,
  onFaceSelect,
  onFaceDoubleSelect,
}) {
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
        <select
          className="face-select"
          value={normalizeFace(shape.face)}
          onChange={(event) => onChange({ face: event.target.value })}
          aria-label={`${getShapeLabel(shape)} face`}
        >
          {FACE_ORDER.map((face) => (
            <option key={face} value={face}>{FACE_LABELS[face]}</option>
          ))}
        </select>
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
