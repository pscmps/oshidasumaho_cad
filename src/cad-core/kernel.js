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
import { centeredCoordinate, normalizePlanRing, ringsEqualPoint } from './projection.js';
const FACE_ORDER = ['top', 'front', 'right'];
const normalizeFace = face => FACE_ORDER.includes(face) ? face : 'top';
function getReplicadPlaneConfig(shape, face, dimensions) {
  const rackDimensions = shape.type === 'rack' ? getRackGearDimensions(shape) : null;
  const centerU = shape.type === 'rect'
    ? shape.x + shape.w / 2
    : shape.type === 'rack'
      ? shape.x + rackDimensions.boundsWidth / 2
      : shape.x;
  const centerV = shape.type === 'rect'
    ? shape.y + shape.h / 2
    : shape.type === 'rack'
      ? shape.y + rackDimensions.boundsHeight / 2
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
      x: -rackDimensions.boundsWidth / 2,
      y: -rackDimensions.boundsHeight / 2,
    };
    // The unextended rack repeats the terminal root point. OCC rejects the
    // resulting zero-length segment; use the existing polygon normalization.
    const ring = normalizePlanRing(getRackGearOutlineRing(localRack)).filter((point, i, points) => i === 0 || !ringsEqualPoint(point, points[i - 1]));
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


export { buildReplicadSolid };
