import {
  GEAR_MODULE_MAX,
  GEAR_MODULE_MIN,
  GEAR_PRESSURE_ANGLE_DEG,
} from './gear-geometry.js';

export const INTERNAL_GEAR_TEETH_MIN = 34;
export const INTERNAL_GEAR_TEETH_MAX = 120;

const PROFILE_CACHE = new Map();

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function involuteAngle(radius, baseRadius) {
  if (radius <= baseRadius) {
    return 0;
  }
  const parameter = Math.sqrt((radius / baseRadius) ** 2 - 1);
  return parameter - Math.atan(parameter);
}

export function getInternalGearRadii(shape) {
  const moduleValue = clamp(Number(shape.module) || 1, GEAR_MODULE_MIN, GEAR_MODULE_MAX);
  const teeth = clamp(
    Math.round(Number(shape.teeth) || 50),
    INTERNAL_GEAR_TEETH_MIN,
    INTERNAL_GEAR_TEETH_MAX,
  );
  const pitchRadius = moduleValue * teeth / 2;
  const baseRadius = pitchRadius * Math.cos((GEAR_PRESSURE_ANGLE_DEG * Math.PI) / 180);
  const tipRadius = pitchRadius - moduleValue;
  const rootRadius = pitchRadius + 1.25 * moduleValue;
  const minimumRim = Math.max(1, moduleValue / 2);
  const minimumOuterRadius = rootRadius + minimumRim;
  const requestedOuterRadius = (Number(shape.outerDiameter) || (tipRadius + 10) * 2) / 2;
  const outerRadius = Math.max(minimumOuterRadius, requestedOuterRadius);
  return {
    module: moduleValue,
    teeth,
    pitchRadius,
    baseRadius,
    tipRadius,
    rootRadius,
    minimumRim,
    minimumOuterRadius,
    minimumOuterDiameter: minimumOuterRadius * 2,
    outerRadius,
    outerDiameter: outerRadius * 2,
  };
}

export function getInternalGearMinimumOuterDiameter(shape) {
  return getInternalGearRadii({ ...shape, outerDiameter: 0 }).minimumOuterDiameter;
}

export function getInternalGearMaximumTeeth(shape, outerDiameter = shape.outerDiameter) {
  const moduleValue = clamp(Number(shape.module) || 1, GEAR_MODULE_MIN, GEAR_MODULE_MAX);
  const outerRadius = Math.max(0, Number(outerDiameter) / 2);
  const minimumRim = Math.max(1, moduleValue / 2);
  return clamp(
    Math.floor(((outerRadius - minimumRim) / moduleValue - 1.25) * 2),
    INTERNAL_GEAR_TEETH_MIN,
    INTERNAL_GEAR_TEETH_MAX,
  );
}

export function getInternalGearMaximumModule(shape, outerDiameter = shape.outerDiameter) {
  const maxOuterDiameter = Math.max(0, Number(outerDiameter));
  let maximum = GEAR_MODULE_MIN;
  for (let candidate = GEAR_MODULE_MIN; candidate <= GEAR_MODULE_MAX + 0.001; candidate += 0.5) {
    if (getInternalGearMinimumOuterDiameter({ ...shape, module: candidate }) <= maxOuterDiameter + 0.001) {
      maximum = candidate;
    }
  }
  return maximum;
}

function getInnerToothProfile(shape, flankSamples = 4, tipSamples = 2, rootSamples = 2) {
  const radii = getInternalGearRadii(shape);
  const cacheKey = [radii.module, radii.teeth, flankSamples, tipSamples, rootSamples].join(':');
  const cached = PROFILE_CACHE.get(cacheKey);
  if (cached) {
    return cached;
  }

  const pitchAngle = Math.PI * 2 / radii.teeth;
  const halfSpaceAtPitch = Math.PI / (2 * radii.teeth);
  const pitchInvolute = involuteAngle(radii.pitchRadius, radii.baseRadius);
  const tipHalfAngle = halfSpaceAtPitch + pitchInvolute - involuteAngle(radii.tipRadius, radii.baseRadius);
  const rootHalfAngle = halfSpaceAtPitch + pitchInvolute - involuteAngle(radii.rootRadius, radii.baseRadius);
  const profile = [{ angle: -pitchAngle / 2, radius: radii.tipRadius }];

  for (let index = 1; index <= tipSamples; index += 1) {
    const ratio = index / tipSamples;
    profile.push({
      angle: -pitchAngle / 2 + (pitchAngle / 2 - tipHalfAngle) * ratio,
      radius: radii.tipRadius,
    });
  }
  for (let index = 1; index <= flankSamples; index += 1) {
    const ratio = index / flankSamples;
    const radius = radii.tipRadius + (radii.rootRadius - radii.tipRadius) * ratio;
    const halfAngle = halfSpaceAtPitch + pitchInvolute - involuteAngle(radius, radii.baseRadius);
    profile.push({ angle: -halfAngle, radius });
  }
  for (let index = 1; index <= rootSamples; index += 1) {
    const ratio = index / (rootSamples + 1);
    profile.push({
      angle: -rootHalfAngle + rootHalfAngle * 2 * ratio,
      radius: radii.rootRadius,
    });
  }
  for (let index = flankSamples; index >= 0; index -= 1) {
    const ratio = index / flankSamples;
    const radius = radii.tipRadius + (radii.rootRadius - radii.tipRadius) * ratio;
    const halfAngle = halfSpaceAtPitch + pitchInvolute - involuteAngle(radius, radii.baseRadius);
    profile.push({ angle: halfAngle, radius });
  }
  for (let index = 1; index <= tipSamples; index += 1) {
    const ratio = index / tipSamples;
    profile.push({
      angle: tipHalfAngle + (pitchAngle / 2 - tipHalfAngle) * ratio,
      radius: radii.tipRadius,
    });
  }

  const result = { profile, pitchAngle, ...radii };
  PROFILE_CACHE.set(cacheKey, result);
  return result;
}

function polarPoint(shape, radius, angle) {
  return [
    shape.x + Math.cos(angle) * radius,
    shape.y + Math.sin(angle) * radius,
  ];
}

export function getInternalGearInnerRing(shape, flankSamples = 4) {
  const { profile, pitchAngle, teeth } = getInnerToothProfile(shape, flankSamples);
  const ring = Array.from({ length: teeth }, (_, toothIndex) => {
    const centerAngle = toothIndex * pitchAngle;
    const points = toothIndex === teeth - 1 ? profile : profile.slice(0, -1);
    return points.map(({ angle, radius }) => polarPoint(shape, radius, centerAngle + angle));
  }).flat();
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (Math.hypot(first[0] - last[0], first[1] - last[1]) < 0.000001) {
    ring.pop();
  }
  return ring.reverse();
}

export function getInternalGearOuterRing(shape, segments = 96) {
  const { outerRadius } = getInternalGearRadii(shape);
  return Array.from({ length: segments }, (_, index) => {
    const angle = Math.PI * 2 * index / segments;
    return polarPoint(shape, outerRadius, angle);
  });
}

function normalizeToothAngle(angle, pitchAngle) {
  return ((((angle + pitchAngle / 2) % pitchAngle) + pitchAngle) % pitchAngle) - pitchAngle / 2;
}

function getInnerBoundaryRadius(shape, angle) {
  const { profile, pitchAngle } = getInnerToothProfile(shape);
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

export function getInternalGearOuterSignedDistance(shape, x, y) {
  const { outerRadius } = getInternalGearRadii(shape);
  return outerRadius - Math.hypot(x - shape.x, y - shape.y);
}

export function getInternalGearInnerSignedDistance(shape, x, y) {
  const dx = x - shape.x;
  const dy = y - shape.y;
  return Math.hypot(dx, dy) - getInnerBoundaryRadius(shape, Math.atan2(dy, dx));
}

export function pointInInternalGearOuter(shape, x, y) {
  return getInternalGearOuterSignedDistance(shape, x, y) >= 0;
}

export function pointInInternalGear(shape, x, y) {
  return pointInInternalGearOuter(shape, x, y) && getInternalGearInnerSignedDistance(shape, x, y) >= 0;
}
