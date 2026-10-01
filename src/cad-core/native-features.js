// Dedicated BRep feature construction. No legacy projection/SVG geometry is used here.
import { VIEW_AXES } from './rough-sketch.js';

function drawingOf(r, contour, sizes) {
  if (contour.type === 'ellipse') {
    const [rx, ry] = contour.radii.map((n, i) => n * sizes[i]);
    const drawing = Math.abs(rx - ry) < 1e-8 ? r.drawCircle(rx)
      : rx >= ry ? r.drawEllipse(rx, ry) : r.drawEllipse(ry, rx).rotate(90);
    return drawing.translate(contour.center.map((n, i) => n * sizes[i]));
  }
  const points = contour.points.map(p => p.map((n, i) => n * sizes[i]));
  const pen = r.draw(points[0]); points.slice(1).forEach(p => pen.lineTo(p));
  return pen.close();
}

export function buildNativeBase(r, f, own) {
  if (f.type === 'extrude') {
    const sketch = f.profile.type === 'rectangle'
      ? r.sketchRectangle(f.profile.width, f.profile.height, { plane: 'XY', origin: f.origin })
      : r.sketchCircle(f.profile.radius, { plane: 'XY', origin: f.origin });
    return sketch.extrude(f.distance);
  }
  const { width, depth, height } = f.dimensions;
  const planes = { top: ['XY', [0, 0, 0], height], front: ['XZ', [0, depth, 0], depth], right: ['YZ', [width, 0, 0], -width] };
  let solid;
  for (const [view, profile] of Object.entries(f.profiles)) {
    const sizes = VIEW_AXES[view].map(k => f.dimensions[k]);
    let drawing = drawingOf(r, profile.outer, sizes);
    for (const hole of profile.holes) drawing = drawing.cut(drawingOf(r, hole, sizes));
    const [plane, origin, distance] = planes[view];
    const prism = own(drawing.sketchOnPlane(plane, origin).extrude(distance));
    solid = solid ? own(solid.intersect(prism)) : prism;
  }
  const clean = own(solid.simplify());
  return clean.translate(f.origin);
}

export function applyNativeModifier(r, input, f, selected, own) {
  if (f.type === 'transform') {
    let shape = own(input.clone());
    f.rotation.forEach((angle, i) => { if (angle) shape = own(shape.rotate(angle, [0, 0, 0], [i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0])); });
    return shape.translate(f.translation);
  }
  if (f.type === 'faceExtrude') {
    if (selected.some(s => s.entity.geomType !== 'PLANE')) throw new Error('面を伸ばす・削る操作は平面に対応しています');
    let shape = own(input.clone());
    for (const { entity } of selected) {
      const normal = entity.normalAt(), normalized = normal.normalized();
      const direction = normalized.toTuple(); normal.delete(); normalized.delete();
      const vector = new r.Vector(direction.map(n => n * f.distance));
      let tool;
      try { tool = own(r.basicFaceExtrusion(entity, vector)); } finally { vector.delete(); }
      shape = own(f.distance > 0 ? shape.fuse(tool) : shape.cut(tool));
    }
    return shape.simplify();
  }
  const faceEdges = selected.filter(s => s.entityType === 'face').flatMap(s => s.entity.edges);
  const edges = [...selected.filter(s => s.entityType === 'edge').map(s => s.entity), ...faceEdges];
  try {
    const shape = own(input[f.type](edge => edges.some(e => e.isSame(edge)) ? (f.type === 'fillet' ? f.radius : f.distance) : null));
    return shape.simplify();
  } finally { faceEdges.forEach(e => e.delete()); }
}
