import { buildReplicadSolid } from './kernel.js';
import { getAllFaceBounds, getDocumentPreviewDimensions } from './projection.js';
import { diagnoseProjectionConsistency } from '../projection-consistency.js';
import { cadOf, validateCad, PROJECTION_FEATURE_ID } from './document.js';
import { geometrySelector, resolveReference } from './selectors.js';
import { classifyEdges } from './topology-display.js';
import { buildNativeBase, applyNativeModifier } from './native-features.js';

function boundsOf(shape) {
  const box = shape.boundingBox;
  try { return box.bounds; } finally { box.delete(); }
}
function tuple(vector) { try { return vector.toTuple(); } finally { vector.delete(); } }
function directionOf(entity, type) {
  if (type === 'face' && entity.geomType === 'PLANE') {
    const normal = entity.normalAt(), normalized = normal.normalized();
    normal.delete(); return tuple(normalized);
  }
  if (type === 'edge' && entity.geomType === 'LINE') {
    const tangent = entity.tangentAt(), normalized = tangent.normalized();
    tangent.delete();
    const v = tuple(normalized);
    const sign = v.find(n => Math.abs(n) > 1e-6) < 0 ? -1 : 1;
    return v.map(n => n * sign);
  }
  return null;
}
function describe(entity, entityType, body) {
  const [min, max] = boundsOf(entity);
  return {
    featureId: body.featureId, entityType, lineage: body.lineage,
    entitySelector: geometrySelector({ geometryType: entity.geomType,
      center: min.map((v, i) => (v + max[i]) / 2), size: max.map((v, i) => v - min[i]),
      direction: directionOf(entity, entityType) }, boundsOf(body.shape)),
    entity,
  };
}
function entitiesOf(body) {
  const faces = body.shape.faces, edges = body.shape.edges;
  try { return [...faces.map(f => describe(f, 'face', body)), ...edges.map(e => describe(e, 'edge', body))]; }
  catch (error) { [...faces, ...edges].forEach(e => e.delete()); throw error; }
}
function selectedEntities(body, targets) {
  const candidates = entitiesOf(body);
  try { return { selected: targets.map(t => resolveReference(t, candidates)), release: () => candidates.forEach(c => c.entity.delete()) }; }
  catch (error) { candidates.forEach(c => c.entity.delete()); throw error; }
}

// Evaluates a restricted feature graph with the existing replicad/OpenCascade kernel.
// Call dispose after meshing/exporting; no kernel objects cross a worker boundary.
export function evaluateDocument(replicad, document) {
  const cad = cadOf(document); validateCad(cad);
  const bodies = new Map(), allocated = [];
  const own = shape => { allocated.push(shape); return shape; };
  const dispose = () => allocated.forEach(s => { try { s.delete(); } catch { /* consumed transform */ } });
  try {
    if (!cad.suppressedProjection && document.shapes?.length
      && diagnoseProjectionConsistency(getAllFaceBounds(document.shapes)).valid) {
      bodies.set(PROJECTION_FEATURE_ID, { featureId: PROJECTION_FEATURE_ID, lineage: [PROJECTION_FEATURE_ID],
        shape: own(buildReplicadSolid(replicad, document, getDocumentPreviewDimensions(document))) });
    }
    for (const f of cad.features) {
      let shape, lineage = [f.id];
      if (['extrude', 'sketchSolid'].includes(f.type)) {
        shape = buildNativeBase(replicad, f, own);
      } else {
        const input = bodies.get(f.input);
        if (!input) throw new Error(`入力 ${f.input} を生成できません。3面の外形を確認してください。`);
        lineage = [...input.lineage, f.id];
        if (f.type === 'transform') {
          shape = applyNativeModifier(replicad, input.shape, f, [], own);
        } else {
          const { selected, release } = selectedEntities(input, f.targets);
          try {
            shape = applyNativeModifier(replicad, input.shape, f, selected, own);
          } finally { release(); }
        }
        bodies.delete(f.input);
      }
      if (shape.isNull) throw new Error(`${f.id} は空の形状です。`);
      own(shape);
      bodies.set(f.id, { featureId: f.id, lineage, shape });
    }
    return { bodies: [...bodies.values()], dispose };
  } catch (error) { dispose(); throw error; }
}

export function meshDocument(evaluated) {
  return { bodies: evaluated.bodies.map(body => {
    // Read analytic bounds before meshing: OCC can inflate tessellated bounds
    // by mesh deflection, which must never become part of persistent naming.
    const candidates = entitiesOf(body);
    const bounds = boundsOf(body.shape);
    const edgeClasses = classifyEdges(body.shape.oc, candidates);
    const ref = c => ({ featureId: c.featureId, entityType: c.entityType, entitySelector: c.entitySelector });
    try {
      const mesh = body.shape.mesh({ tolerance: 0.05, angularTolerance: 0.08 });
      if (!mesh.triangles.length) throw new Error('有効な三角形を生成できませんでした。');
      const edgeMesh = body.shape.meshEdges({ tolerance: 0.1, angularTolerance: 0.15 });
      return {
        featureId: body.featureId, lineage: body.lineage, bounds,
        bodyReference: { featureId: body.featureId, entityType: 'body', entitySelector: { kind: 'body' } },
        faces: mesh.faceGroups.map(g => {
          const c = candidates.find(c => c.entityType === 'face' && c.entity.hashCode === g.faceId);
          if (!c) throw new Error('Faceと表示メッシュの対応付けに失敗しました。');
          return { reference: ref(c), vertices: mesh.vertices, normals: mesh.normals, triangles: mesh.triangles.slice(g.start, g.start + g.count) };
        }),
        edges: edgeMesh.edgeGroups.map(g => {
          const c = candidates.find(c => c.entityType === 'edge' && c.entity.hashCode === g.edgeId);
          if (!c) throw new Error('Edgeと表示メッシュの対応付けに失敗しました。');
          return { reference: ref(c), appearance: edgeClasses.get(c.entity.hashCode), lines: edgeMesh.lines.slice(g.start * 3, (g.start + g.count) * 3) };
        }),
      };
    } finally { candidates.forEach(c => c.entity.delete()); }
  }) };
}

export function exportEvaluated(replicad, evaluated, format, name = 'oshidasumaho-cad-output', resolution = 1) {
  if (!evaluated.bodies.length) throw new Error('出力するBodyがありません。');
  if (!['step', 'stl'].includes(format)) throw new Error('未対応の出力形式です。');
  // makeCompound consumes its input wrappers; preserve the evaluated bodies.
  const compound = replicad.makeCompound(evaluated.bodies.map(b => b.shape.clone()));
  try {
    if (format === 'step') {
      // replicad 0.23's XCAF exporter registers both a raw WorkSession and its
      // owning Handle for finalization. Its double destruction can corrupt WASM
      // during repeated exports. Use the existing shape exporter for parts.
      const oc = replicad.getOC();
      oc.Interface_Static.SetCVal('xstep.cascade.unit', 'MM');
      oc.Interface_Static.SetCVal('write.step.unit', 'MM');
      return compound.blobSTEP();
    }
    return compound.blobSTL({ tolerance: 0.1 / Math.max(1, resolution), angularTolerance: 0.15, binary: false });
  }
  finally { compound.delete(); }
}
