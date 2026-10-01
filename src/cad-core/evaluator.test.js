import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { testKernel } from './test-kernel.js';
import { evaluateDocument, meshDocument, exportEvaluated } from './evaluator.js';
import { executeCommands } from '../cad-command/executor.js';
import { emptyCad } from './document.js';
import { parseModelJson, serializeModelJson } from '../model-json.js';

const kernel = await testKernel();
const document = executeCommands({ shapes: [], schemaVersion: 5, cad: emptyCad() }, [{ operation: 'addExtrude', profile: { type: 'rectangle', width: 40, height: 30 }, distance: 10, origin: [0, 0, 0] }]);
function evaluated(doc, fn) { const result = evaluateDocument(kernel, doc); try { return fn(result); } finally { result.dispose(); } }
const mesh = evaluated(document, meshDocument);
const top = mesh.bodies[0].faces.find(f => f.reference.entitySelector.center[2] > 0.99);
const edge = mesh.bodies[0].edges.find(e => e.reference.entitySelector.direction?.[2] > 0.99);
const marked = ref => ({ ...document, cad: { ...document.cad, selectionGroups: { red: [ref], green: [], blue: [] } } });

test('exact kernel maps six faces and twelve edges to persistent geometric selectors', () => {
  assert.equal(mesh.bodies[0].faces.length, 6); assert.equal(mesh.bodies[0].edges.length, 12);
  assert.ok(top); assert.ok(edge);
  assert.ok(mesh.bodies[0].faces.every(f => !('index' in f.reference.entitySelector)));
});
test('selected planar face extrudes and cuts along its outward normal', () => {
  for (const distance of [5, -3]) {
    const edited = executeCommands(marked(top.reference), [{ operation: 'extrudeSelectedFaces', selectionGroup: 'red', distance }]);
    evaluated(edited, result => { const box = result.bodies[0].shape.boundingBox; try { assert.ok(Math.abs(box.bounds[1][2] - (10 + distance)) < 1e-4); } finally { box.delete(); } });
  }
});
test('fillet, radius modification and chamfer produce real kernel shapes', () => {
  for (const operation of ['fillet', 'chamfer']) {
    let edited = executeCommands(marked(edge.reference), [{ operation, selectionGroup: 'red', ...(operation === 'fillet' ? { radius: 2 } : { distance: 1 }) }]);
    evaluated(edited, result => assert.ok(meshDocument(result).bodies[0].faces.length > 6));
    if (operation === 'fillet') {
      edited = executeCommands(edited, [{ operation: 'modifyFeature', featureId: 'fillet-1', changes: { radius: 3 } }]);
      evaluated(edited, result => assert.ok(meshDocument(result).bodies[0].faces.length > 6));
    }
  }
});
test('distance changes preserve normalized selector after JSON round trip and regeneration', () => {
  const edited = executeCommands(marked(edge.reference), [{ operation: 'changeDistance', selectionGroup: 'red', distance: 20 }]);
  const imported = parseModelJson(serializeModelJson(edited));
  const filleted = executeCommands(imported, [{ operation: 'fillet', selectionGroup: 'red', radius: 2 }]);
  evaluated(filleted, result => assert.ok(meshDocument(result).bodies[0].faces.length > 6));
});
test('transform and exact STEP/STL export use the edited feature body', async () => {
  const edited = executeCommands(marked(mesh.bodies[0].bodyReference), [{ operation: 'transform', selectionGroup: 'red', translation: [7, 0, 0], rotation: [0, 0, 90] }]);
  const result = evaluateDocument(kernel, edited);
  try {
    const box = result.bodies[0].shape.boundingBox;
    try { assert.ok(Math.abs(box.center[0] - 7) < 1e-4); } finally { box.delete(); }
    assert.match(await exportEvaluated(kernel, result, 'step').text(), /ISO-10303-21/);
    assert.match(await exportEvaluated(kernel, result, 'stl').text(), /facet normal/);
  } finally { result.dispose(); }
});
test('existing bracket, gear, rack and internal gear build exact geometry and STEP', async () => {
  for (const name of ['three-face-bracket', 'spur-gear', 'rack-gear', 'internal-gear']) {
    const doc = parseModelJson(await readFile(new URL(`../../examples/${name}.json`, import.meta.url), 'utf8'));
    const result = evaluateDocument(kernel, doc);
    try {
      assert.equal(result.bodies.length, 1, name);
      assert.ok(meshDocument(result).bodies[0].faces.length > 0, name);
      assert.match(await exportEvaluated(kernel, result, 'step').text(), /ISO-10303-21/, name);
    } finally { result.dispose(); }
  }
});
