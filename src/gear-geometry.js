export const GEAR_MODULE_MIN = 0.5;
export const GEAR_MODULE_MAX = 5;
export const GEAR_TEETH_MIN = 8;
export const GEAR_TEETH_MAX = 80;
export const GEAR_PRESSURE_ANGLE_DEG = 20;

const PROFILE_CACHE = new Map();

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function polarPoint(centerX, centerY, radius, angle) {
  return [
    centerX + Math.cos(angle) * radius,
    centerY + Math.sin(angle) * radius,
  ];
}

export function getGearRadii(shape) {
  const moduleValue = clamp(Number(shape.module) || 1, GEAR_MODULE_MIN, GEAR_MODULE_MAX);
  const teeth = clamp(Math.round(Number(shape.teeth) || 24), GEAR_TEETH_MIN, GEAR_TEETH_MAX);
  const pitchRadius = (moduleValue * teeth) / 2;
  const baseRadius = pitchRadius * Math.cos((GEAR_PRESSURE_ANGLE_DEG * Math.PI) / 180);
  const outerRadius = pitchRadius + moduleValue;
  const rootRadius = Math.max(moduleValue, pitchRadius - 1.25 * moduleValue);
  const boreRadius = clamp((Number(shape.bore) || 0) / 2, 0, Math.max(0, rootRadius - 0.1));
  return {
    module: moduleValue,
    teeth,
    pitchRadius,
    baseRadius,
    outerRadius,
    rootRadius,
    boreRadius,
  };
}

export function getGearBoreMax(shape) {
  const { module: moduleValue, rootRadius } = getGearRadii({ ...shape, bore: 0 });
  const minimumWall = Math.max(0.5, moduleValue / 2);
  return Math.max(0, (rootRadius - minimumWall) * 2);
}

function involuteAngle(radius, baseRadius) {
  if (radius <= baseRadius) {
    return 0;
  }
  const parameter = Math.sqrt((radius / baseRadius) ** 2 - 1);
  return parameter - Math.atan(parameter);
}

function getToothProfile(shape, flankSamples = 4, tipSamples = 3) {
  const radii = getGearRadii(shape);
  const cacheKey = [
    radii.module,
    radii.teeth,
    flankSamples,
    tipSamples,
  ].join(':');
  const cached = PROFILE_CACHE.get(cacheKey);
  if (cached) {
    return cached;
  }

  const pitchAngle = (Math.PI * 2) / radii.teeth;
  const halfToothAtPitch = Math.PI / (2 * radii.teeth);
  const pitchInvolute = involuteAngle(radii.pitchRadius, radii.baseRadius);
  const flankStartRadius = Math.max(radii.rootRadius, radii.baseRadius);
  const flankStartInvolute = involuteAngle(flankStartRadius, radii.baseRadius);
  const flankStartHalfAngle = halfToothAtPitch + pitchInvolute - flankStartInvolute;
  const outerInvolute = involuteAngle(radii.outerRadius, radii.baseRadius);
  const outerHalfAngle = halfToothAtPitch + pitchInvolute - outerInvolute;
  const profile = [
    { angle: -pitchAngle / 2, radius: radii.rootRadius },
    { angle: -flankStartHalfAngle, radius: radii.rootRadius },
  ];

  for (let index = 0; index <= flankSamples; index += 1) {
    const ratio = index / flankSamples;
    const radius = flankStartRadius + (radii.outerRadius - flankStartRadius) * ratio;
    const halfAngle = halfToothAtPitch + pitchInvolute - involuteAngle(radius, radii.baseRadius);
    profile.push({ angle: -halfAngle, radius });
  }
  for (let index = 1; index <= tipSamples; index += 1) {
    const ratio = index / (tipSamples + 1);
    profile.push({
      angle: -outerHalfAngle + outerHalfAngle * 2 * ratio,
      radius: radii.outerRadius,
    });
  }
  for (let index = flankSamples; index >= 0; index -= 1) {
    const ratio = index / flankSamples;
    const radius = flankStartRadius + (radii.outerRadius - flankStartRadius) * ratio;
    const halfAngle = halfToothAtPitch + pitchInvolute - involuteAngle(radius, radii.baseRadius);
    profile.push({ angle: halfAngle, radius });
  }
  profile.push(
    { angle: flankStartHalfAngle, radius: radii.rootRadius },
    { angle: pitchAngle / 2, radius: radii.rootRadius },
  );

  const result = { profile, pitchAngle, ...radii };
  PROFILE_CACHE.set(cacheKey, result);
  return result;
}

export function getGearOutlineRing(shape, flankSamples = 4) {
  const { profile, pitchAngle, teeth } = getToothProfile(shape, flankSamples);
  const centerX = Number(shape.x) || 0;
  const centerY = Number(shape.y) || 0;
  return Array.from({ length: teeth }, (_, toothIndex) => {
    const centerAngle = toothIndex * pitchAngle;
    const points = toothIndex === teeth - 1 ? profile : profile.slice(0, -1);
    return points.map(({ angle, radius }) => polarPoint(centerX, centerY, radius, centerAngle + angle));
  }).flat();
}

export function getGearBoreRing(shape, segments = 64) {
  const { boreRadius } = getGearRadii(shape);
  if (boreRadius <= 0) {
    return [];
  }
  return Array.from({ length: segments }, (_, index) => {
    const angle = (Math.PI * 2 * (segments - index)) / segments;
    return polarPoint(shape.x, shape.y, boreRadius, angle);
  });
}

function normalizeToothAngle(angle, pitchAngle) {
  return ((((angle + pitchAngle / 2) % pitchAngle) + pitchAngle) % pitchAngle) - pitchAngle / 2;
}

function getBoundaryRadius(shape, angle) {
  const { profile, pitchAngle } = getToothProfile(shape);
  const localAngle = normalizeToothAngle(angle, pitchAngle);
  let low = 0;
  let high = profile.length - 1;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (profile[middle].angle <= localAngle) {
      low = middle;
    } else {
      high = middle;
    }
  }
  const first = profile[low];
  const second = profile[high];
  const span = second.angle - first.angle;
  const ratio = span > 0.000001 ? (localAngle - first.angle) / span : 0;
  return first.radius + (second.radius - first.radius) * ratio;
}

export function getGearOuterSignedDistance(shape, x, y) {
  const dx = x - shape.x;
  const dy = y - shape.y;
  const radius = Math.hypot(dx, dy);
  return getBoundaryRadius(shape, Math.atan2(dy, dx)) - radius;
}

export function getGearBoreSignedDistance(shape, x, y) {
  const { boreRadius } = getGearRadii(shape);
  return Math.hypot(x - shape.x, y - shape.y) - boreRadius;
}

export function pointInGearOuter(shape, x, y) {
  return getGearOuterSignedDistance(shape, x, y) >= 0;
}

export function pointInGear(shape, x, y) {
  return pointInGearOuter(shape, x, y) && getGearBoreSignedDistance(shape, x, y) >= 0;
}
