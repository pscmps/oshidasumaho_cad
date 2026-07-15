import { getGearRadii } from './gear-geometry.js';
import { getInternalGearRadii } from './internal-gear-geometry.js';
import { roundToModelPrecision } from './numeric-precision.js';
import { getRackGearDimensions, normalizeRackRotation } from './rack-gear-geometry.js';

export const FIT_CAPTURE_DISTANCE = 0.6;
export const FIT_RELEASE_DISTANCE = 2;

const ALIGNMENT_TOLERANCE = 0.051;
const STRAIGHT_EDGE_EPSILON = 0.001;
const MINIMUM_STEP_LENGTH = 1;

function uniqueSorted(values) {
  return [...new Set(values.map(roundToModelPrecision))].sort((a, b) => a - b);
}

export function isFitBypassActive(rawValue, snappedValue) {
  return Math.abs(Number(rawValue) - Number(snappedValue)) < FIT_RELEASE_DISTANCE;
}

export function getShapeBounds2D(shape) {
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
      maxX: shape.x + dimensions.boundsWidth,
      minY: shape.y,
      maxY: shape.y + dimensions.boundsHeight,
      width: dimensions.boundsWidth,
      height: dimensions.boundsHeight,
      centerX: shape.x + dimensions.boundsWidth / 2,
      centerY: shape.y + dimensions.boundsHeight / 2,
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

export function extractAxisFitTargets(polygons, axis) {
  const points = polygons.flatMap((polygon) => polygon.flatMap((ring) => ring));
  if (!points.length) {
    return null;
  }

  const coordinateIndex = axis === 'x' ? 0 : 1;
  const crossIndex = axis === 'x' ? 1 : 0;
  const coordinates = points.map((point) => point[coordinateIndex]);
  const min = Math.min(...coordinates);
  const max = Math.max(...coordinates);
  const edges = [min, max];

  polygons.forEach((polygon) => polygon.forEach((ring) => {
    ring.forEach((point, index) => {
      const next = ring[(index + 1) % ring.length];
      const axisDelta = Math.abs(point[coordinateIndex] - next[coordinateIndex]);
      const crossLength = Math.abs(point[crossIndex] - next[crossIndex]);
      if (axisDelta <= STRAIGHT_EDGE_EPSILON && crossLength >= MINIMUM_STEP_LENGTH) {
        edges.push((point[coordinateIndex] + next[coordinateIndex]) / 2);
      }
    });
  }));

  return {
    edges: uniqueSorted(edges),
    center: roundToModelPrecision((min + max) / 2),
    centers: [roundToModelPrecision((min + max) / 2)],
    size: roundToModelPrecision(max - min),
    sizes: [roundToModelPrecision(max - min)],
  };
}

export function includeShapeFitTargets(targets, shapes, axis) {
  if (!targets && !shapes.length) {
    return null;
  }
  const edges = [...(targets?.edges ?? [])];
  const centers = [...(targets?.centers ?? (Number.isFinite(targets?.center) ? [targets.center] : []))];
  const sizes = [...(targets?.sizes ?? (Number.isFinite(targets?.size) ? [targets.size] : []))];
  shapes.forEach((shape) => {
    const bounds = getShapeBounds2D(shape);
    if (axis === 'x') {
      edges.push(bounds.minX, bounds.maxX);
      centers.push(bounds.centerX);
      sizes.push(bounds.width);
    } else {
      edges.push(bounds.minY, bounds.maxY);
      centers.push(bounds.centerY);
      sizes.push(bounds.height);
    }
  });
  const normalizedCenters = uniqueSorted(centers);
  const normalizedSizes = uniqueSorted(sizes);
  return {
    ...(targets ?? {}),
    edges: uniqueSorted(edges),
    center: targets?.center ?? normalizedCenters[0],
    centers: normalizedCenters,
    size: targets?.size ?? normalizedSizes[0],
    sizes: normalizedSizes,
  };
}

function getFitAxes(shape, field) {
  if (field === 'x' || field === 'y') {
    return [field];
  }
  if (shape.type === 'rect') {
    if (field === 'w') return ['x'];
    if (field === 'h') return ['y'];
  }
  if (shape.type === 'circle' && field === 'r') {
    return ['x', 'y'];
  }
  if (shape.type === 'rack') {
    const vertical = [90, 270].includes(normalizeRackRotation(shape.rotation));
    if (field === 'width') return [vertical ? 'y' : 'x'];
    if (field === 'height') return [vertical ? 'x' : 'y'];
  }
  if (shape.type === 'internalGear' && field === 'outerDiameter') {
    return ['x', 'y'];
  }
  return [];
}

function getAlignmentChecks(bounds, axis, targets, positionField) {
  if (!targets) {
    return [];
  }
  const min = axis === 'x' ? bounds.minX : bounds.minY;
  const max = axis === 'x' ? bounds.maxX : bounds.maxY;
  const center = axis === 'x' ? bounds.centerX : bounds.centerY;
  const size = axis === 'x' ? bounds.width : bounds.height;
  const checks = targets.edges.flatMap((target) => [
    { error: Math.abs(min - target), kind: 'min', target },
    { error: Math.abs(max - target), kind: 'max', target },
  ]);
  if (positionField) {
    (targets.centers ?? [targets.center]).filter(Number.isFinite).forEach((target) => {
      checks.push({ error: Math.abs(center - target), kind: 'center', target });
    });
  } else {
    (targets.sizes ?? [targets.size]).filter(Number.isFinite).forEach((target) => {
      checks.push({ error: Math.abs(size - target), kind: 'size', target });
    });
  }
  return checks;
}

export function findFitValue({
  shape,
  field,
  rawValue,
  targetsByAxis,
  evaluateShape,
  minValue = -Infinity,
  maxValue = Infinity,
}) {
  const axes = getFitAxes(shape, field);
  if (!axes.length || !Number.isFinite(rawValue)) {
    return null;
  }

  const positionField = field === 'x' || field === 'y';
  const candidates = [];
  for (let offsetStep = -6; offsetStep <= 6; offsetStep += 1) {
    const requestedValue = roundToModelPrecision(rawValue + offsetStep / 10);
    if (
      requestedValue < minValue - 0.001
      || requestedValue > maxValue + 0.001
    ) {
      continue;
    }
    const candidateShape = evaluateShape(requestedValue);
    const candidateValue = Number(candidateShape?.[field]);
    const adjustment = Math.abs(candidateValue - rawValue);
    if (
      !Number.isFinite(candidateValue)
      || (adjustment < 0.05 && offsetStep !== 0)
      || adjustment > FIT_CAPTURE_DISTANCE + 0.001
      || candidateValue < minValue - 0.001
      || candidateValue > maxValue + 0.001
    ) {
      continue;
    }
    const bounds = getShapeBounds2D(candidateShape);
    axes.forEach((axis) => {
      getAlignmentChecks(bounds, axis, targetsByAxis[axis], positionField).forEach((alignment) => {
        if (alignment.error <= ALIGNMENT_TOLERANCE) {
          candidates.push({
            value: roundToModelPrecision(candidateValue),
            adjustment,
            alignmentError: alignment.error,
            axis,
            kind: alignment.kind,
            target: alignment.target,
          });
        }
      });
    });
  }

  candidates.sort((first, second) => (
    first.adjustment - second.adjustment
    || first.alignmentError - second.alignmentError
    || first.target - second.target
  ));
  return candidates[0] ?? null;
}
