export const MODEL_DECIMAL_PLACES = 1;
export const MODEL_PRECISION = 10 ** -MODEL_DECIMAL_PLACES;

const SHAPE_NUMERIC_FIELDS = [
  'x',
  'y',
  'w',
  'h',
  'r',
  'module',
  'bore',
  'height',
  'outerDiameter',
];

export function roundToModelPrecision(value) {
  if (!Number.isFinite(Number(value))) {
    return value;
  }
  return Number(Number(value).toFixed(MODEL_DECIMAL_PLACES));
}

export function floorToModelPrecision(value) {
  if (!Number.isFinite(Number(value))) {
    return value;
  }
  const scale = 10 ** MODEL_DECIMAL_PLACES;
  return Math.floor((Number(value) + Number.EPSILON) * scale) / scale;
}

export function ceilToModelPrecision(value) {
  if (!Number.isFinite(Number(value))) {
    return value;
  }
  const scale = 10 ** MODEL_DECIMAL_PLACES;
  return Math.ceil((Number(value) - Number.EPSILON) * scale) / scale;
}

export function normalizeShapePrecision(shape) {
  if (!shape || typeof shape !== 'object') {
    return shape;
  }
  return SHAPE_NUMERIC_FIELDS.reduce((normalized, field) => {
    if (normalized[field] === undefined) {
      return normalized;
    }
    return { ...normalized, [field]: roundToModelPrecision(normalized[field]) };
  }, { ...shape });
}

export function normalizeConstraintPrecision(constraint) {
  if (!constraint || typeof constraint !== 'object') {
    return constraint;
  }
  return ['minX', 'maxX', 'minY', 'maxY'].reduce((normalized, field) => {
    if (normalized[field] === undefined) {
      return normalized;
    }
    return { ...normalized, [field]: roundToModelPrecision(normalized[field]) };
  }, { ...constraint });
}

export function normalizeModelPrecision(document) {
  if (!document || typeof document !== 'object') {
    return document;
  }
  const constraints = document.areaLockConstraints && typeof document.areaLockConstraints === 'object'
    ? Object.fromEntries(
        Object.entries(document.areaLockConstraints).map(([face, constraint]) => [
          face,
          normalizeConstraintPrecision(constraint),
        ]),
      )
    : document.areaLockConstraints;
  const normalized = { ...document };
  if (document.extrude !== undefined) {
    normalized.extrude = roundToModelPrecision(document.extrude);
  }
  if (document.areaLockConstraints !== undefined) {
    normalized.areaLockConstraints = constraints;
  }
  if (Array.isArray(document.shapes)) {
    normalized.shapes = document.shapes.map(normalizeShapePrecision);
  }
  return normalized;
}
