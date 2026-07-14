import { GEAR_MODULE_MAX, GEAR_MODULE_MIN, GEAR_PRESSURE_ANGLE_DEG } from './gear-geometry.js';

export const RACK_TEETH_MIN = 1;
export const RACK_TEETH_MAX = 80;
export const RACK_HEIGHT_MIN = 1;
export const RACK_HEIGHT_MAX = 120;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function getRackGearDimensions(shape) {
  const moduleValue = clamp(Number(shape.module) || 1, GEAR_MODULE_MIN, GEAR_MODULE_MAX);
  const teeth = clamp(Math.round(Number(shape.teeth) || 20), RACK_TEETH_MIN, RACK_TEETH_MAX);
  const pitch = Math.PI * moduleValue;
  const addendum = moduleValue;
  const dedendum = 1.25 * moduleValue;
  const toothDepth = addendum + dedendum;
  const minimumHeight = Math.ceil(toothDepth);
  const height = clamp(
    Math.round(Number(shape.height) || Math.max(10, minimumHeight)),
    minimumHeight,
    RACK_HEIGHT_MAX,
  );
  const pressureOffset = Math.tan((GEAR_PRESSURE_ANGLE_DEG * Math.PI) / 180);
  const tipHalfWidth = pitch / 4 - addendum * pressureOffset;
  const rootHalfWidth = pitch / 4 + dedendum * pressureOffset;

  return {
    module: moduleValue,
    teeth,
    height,
    minimumHeight,
    pitch,
    width: pitch * teeth,
    toothDepth,
    tipHalfWidth,
    rootHalfWidth,
  };
}

export function getRackGearOutlineRing(shape) {
  const dimensions = getRackGearDimensions(shape);
  const left = Number(shape.x) || 0;
  const top = Number(shape.y) || 0;
  const rootY = top + dimensions.toothDepth;
  const bottom = top + dimensions.height;
  const profile = [];

  for (let index = 0; index < dimensions.teeth; index += 1) {
    const start = left + index * dimensions.pitch;
    const center = start + dimensions.pitch / 2;
    const points = [
      [start, rootY],
      [center - dimensions.rootHalfWidth, rootY],
      [center - dimensions.tipHalfWidth, top],
      [center + dimensions.tipHalfWidth, top],
      [center + dimensions.rootHalfWidth, rootY],
      [start + dimensions.pitch, rootY],
    ];
    profile.push(...(index === 0 ? points : points.slice(1)));
  }

  profile.push(
    [left + dimensions.width, bottom],
    [left, bottom],
  );
  return profile;
}

function getRackProfileY(shape, x) {
  const dimensions = getRackGearDimensions(shape);
  const localX = clamp(x - shape.x, 0, dimensions.width);
  const toothX = localX === dimensions.width
    ? dimensions.pitch
    : localX % dimensions.pitch;
  const center = dimensions.pitch / 2;
  const tipLeft = center - dimensions.tipHalfWidth;
  const tipRight = center + dimensions.tipHalfWidth;
  const rootLeft = center - dimensions.rootHalfWidth;
  const rootRight = center + dimensions.rootHalfWidth;

  if (toothX <= rootLeft || toothX >= rootRight) {
    return shape.y + dimensions.toothDepth;
  }
  if (toothX < tipLeft) {
    const ratio = (toothX - rootLeft) / (tipLeft - rootLeft);
    return shape.y + dimensions.toothDepth * (1 - ratio);
  }
  if (toothX <= tipRight) {
    return shape.y;
  }
  const ratio = (toothX - tipRight) / (rootRight - tipRight);
  return shape.y + dimensions.toothDepth * ratio;
}

export function getRackGearSignedDistance(shape, x, y) {
  const dimensions = getRackGearDimensions(shape);
  const left = shape.x;
  const right = shape.x + dimensions.width;
  const topProfile = getRackProfileY(shape, x);
  const bottom = shape.y + dimensions.height;
  return Math.min(x - left, right - x, y - topProfile, bottom - y);
}

export function pointInRackGear(shape, x, y) {
  return getRackGearSignedDistance(shape, x, y) >= 0;
}
