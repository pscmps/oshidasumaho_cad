import { GEAR_MODULE_MAX, GEAR_MODULE_MIN, GEAR_PRESSURE_ANGLE_DEG } from './gear-geometry.js';
import { roundToModelPrecision } from './numeric-precision.js';

export const RACK_TEETH_MIN = 1;
export const RACK_TEETH_MAX = 80;
export const RACK_HEIGHT_MIN = 1;
export const RACK_HEIGHT_MAX = 120;
export const RACK_ROTATIONS = [0, 90, 180, 270];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function normalizeRackRotation(value) {
  const normalized = ((Math.round(Number(value) / 90) * 90) % 360 + 360) % 360;
  return RACK_ROTATIONS.includes(normalized) ? normalized : 0;
}

export function getRackGearDimensions(shape) {
  const moduleValue = clamp(Number(shape.module) || 1, GEAR_MODULE_MIN, GEAR_MODULE_MAX);
  const teeth = clamp(Math.round(Number(shape.teeth) || 20), RACK_TEETH_MIN, RACK_TEETH_MAX);
  const pitch = Math.PI * moduleValue;
  const nominalWidth = pitch * teeth;
  const profileWidth = roundToModelPrecision(nominalWidth);
  const addendum = moduleValue;
  const dedendum = 1.25 * moduleValue;
  const toothDepth = addendum + dedendum;
  const minimumHeight = Math.ceil(toothDepth);
  const height = clamp(
    Math.round(Number(shape.height) || Math.max(10, minimumHeight)),
    minimumHeight,
    RACK_HEIGHT_MAX,
  );
  const width = clamp(
    roundToModelPrecision(Number(shape.width) || profileWidth),
    profileWidth,
    120,
  );
  const rotation = normalizeRackRotation(shape.rotation);
  const vertical = rotation === 90 || rotation === 270;
  const pressureOffset = Math.tan((GEAR_PRESSURE_ANGLE_DEG * Math.PI) / 180);
  const tipHalfWidth = pitch / 4 - addendum * pressureOffset;
  const rootHalfWidth = pitch / 4 + dedendum * pressureOffset;

  return {
    module: moduleValue,
    teeth,
    height,
    minimumHeight,
    pitch,
    nominalWidth,
    profileWidth,
    width,
    rotation,
    boundsWidth: vertical ? height : width,
    boundsHeight: vertical ? width : height,
    toothDepth,
    tipHalfWidth,
    rootHalfWidth,
  };
}

function rackLocalToWorld(shape, dimensions, localX, localY) {
  if (dimensions.rotation === 90) {
    return [shape.x + dimensions.height - localY, shape.y + localX];
  }
  if (dimensions.rotation === 180) {
    return [shape.x + dimensions.width - localX, shape.y + dimensions.height - localY];
  }
  if (dimensions.rotation === 270) {
    return [shape.x + localY, shape.y + dimensions.width - localX];
  }
  return [shape.x + localX, shape.y + localY];
}

function rackWorldToLocal(shape, dimensions, x, y) {
  const worldX = x - shape.x;
  const worldY = y - shape.y;
  if (dimensions.rotation === 90) {
    return [worldY, dimensions.height - worldX];
  }
  if (dimensions.rotation === 180) {
    return [dimensions.width - worldX, dimensions.height - worldY];
  }
  if (dimensions.rotation === 270) {
    return [dimensions.width - worldY, worldX];
  }
  return [worldX, worldY];
}

export function getRackGearOutlineRing(shape) {
  const dimensions = getRackGearDimensions(shape);
  const rootY = dimensions.toothDepth;
  const bottom = dimensions.height;
  const profile = [];

  for (let index = 0; index < dimensions.teeth; index += 1) {
    const start = index * dimensions.pitch;
    const center = start + dimensions.pitch / 2;
    const points = [
      [start, rootY],
      [center - dimensions.rootHalfWidth, rootY],
      [center - dimensions.tipHalfWidth, 0],
      [center + dimensions.tipHalfWidth, 0],
      [center + dimensions.rootHalfWidth, rootY],
      [Math.min(start + dimensions.pitch, dimensions.profileWidth), rootY],
    ];
    profile.push(...(index === 0 ? points : points.slice(1)));
  }

  profile.push(
    [dimensions.width, rootY],
    [dimensions.width, bottom],
    [0, bottom],
  );
  return profile.map(([x, y]) => rackLocalToWorld(shape, dimensions, x, y));
}

function getRackProfileY(shape, localX) {
  const dimensions = getRackGearDimensions(shape);
  const clampedX = clamp(localX, 0, dimensions.width);
  if (clampedX >= dimensions.profileWidth) {
    return dimensions.toothDepth;
  }
  const toothX = clampedX === dimensions.profileWidth
    ? dimensions.pitch
    : clampedX % dimensions.pitch;
  const center = dimensions.pitch / 2;
  const tipLeft = center - dimensions.tipHalfWidth;
  const tipRight = center + dimensions.tipHalfWidth;
  const rootLeft = center - dimensions.rootHalfWidth;
  const rootRight = center + dimensions.rootHalfWidth;

  if (toothX <= rootLeft || toothX >= rootRight) {
    return dimensions.toothDepth;
  }
  if (toothX < tipLeft) {
    const ratio = (toothX - rootLeft) / (tipLeft - rootLeft);
    return dimensions.toothDepth * (1 - ratio);
  }
  if (toothX <= tipRight) {
    return 0;
  }
  const ratio = (toothX - tipRight) / (rootRight - tipRight);
  return dimensions.toothDepth * ratio;
}

export function getRackGearSignedDistance(shape, x, y) {
  const dimensions = getRackGearDimensions(shape);
  const [localX, localY] = rackWorldToLocal(shape, dimensions, x, y);
  const topProfile = getRackProfileY(shape, localX);
  return Math.min(localX, dimensions.width - localX, localY - topProfile, dimensions.height - localY);
}

export function pointInRackGear(shape, x, y) {
  return getRackGearSignedDistance(shape, x, y) >= 0;
}
