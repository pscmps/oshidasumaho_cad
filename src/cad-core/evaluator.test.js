import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { testKernel } from './test-kernel.js';
import { evaluateDocument, meshDocument, exportEvaluated } from './evaluator.js';
import { executeCommands } from '../cad-command/executor.js';
import { emptyCad } from './document.js';
import { parseModelJson, serializeModelJson } from '../model-json.js';
import { emptyDraft, draftCommand } from './rough-sketch.js';

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
test('rounding removes the sharp corner, keeps CAD normals, and distinguishes tangent boundaries', () => {
  for (const operation of ['fillet', 'chamfer']) {
    const edited = executeCommands(marked(edge.reference), [{ operation, selectionGroup:'red', ...(operation==='fillet'?{radius:3}:{distance:3}) }]);
    evaluated(edited, result => {
      const actual = meshDocument(result).bodies[0];
      const removed = operation==='fillet' ? 9*(1-Math.PI/4)*10 : 9/2*10;
      assert.ok(Math.abs(kernel.measureVolume(result.bodies[0].shape)-(12000-removed))<0.01);
      const center = edge.reference.entitySelector.center;
      assert.ok(!actual.edges.some(e=>e.reference.entitySelector.geometryType==='LINE' && e.reference.entitySelector.direction?.[2] > .99 && e.reference.entitySelector.center.every((n,i)=>Math.abs(n-center[i])<1e-5)));
      if(operation==='fillet') {
        assert.equal(actual.edges.filter(e=>e.appearance==='tangent').length,2);
        const curved=actual.faces.find(f=>f.reference.entitySelector.geometryType==='CYLINDRE');
        assert.ok(curved);
        const normals = new Set(curved.triangles.map(i=>curved.normals.slice(i*3,i*3+3).map(n=>n.toFixed(3)).join(',')));
        assert.ok(normals.size>3, 'CAD curved normals must survive meshing');
      } else assert.equal(actual.edges.filter(e=>e.appearance==='tangent').length,0);
    });
  }
});
test('new sketch profiles intersect three BRep prisms and preserve holes, dimensions and STEP', async () => {
  const d=emptyDraft(); d.dimensions={width:40,depth:30,height:10};
  for(const view of ['top','front','right'])d.views[view].strokes=[{id:view,tool:'rect',role:'outline',points:[[.1,.1],[.9,.9]]}];
  d.views.top.strokes.push({id:'hole',tool:'ellipse',role:'cut',points:[[.4,.4],[.6,.6]]});
  const doc=executeCommands({shapes:[],schemaVersion:5},[draftCommand(d)]), result=evaluateDocument(kernel,doc);
  try {
    const b=meshDocument(result).bodies[0]; assert.ok(b.faces.some(f=>f.reference.entitySelector.geometryType!=='PLANE'));
    assert.ok(Math.abs(kernel.measureVolume(result.bodies[0].shape)-(12000-Math.PI*5*3.75*10))<.01);
    b.bounds[1].forEach((n,i)=>assert.ok(Math.abs(n-[40,30,10][i])<1e-4));
    assert.match(await exportEvaluated(kernel,result,'step').text(),/ISO-10303-21/);
    assert.match(await exportEvaluated(kernel,result,'stl').text(),/facet normal/);
  }finally{result.dispose();}
  const round=executeCommands({shapes:[]},[{operation:'addSketchSolid',origin:[0,0,0],dimensions:{width:20,depth:20,height:5},profiles:{top:{outer:{type:'ellipse',center:[.5,.5],radii:[.5,.5]},holes:[]}}}]);
  evaluated(round,r=>{
    assert.ok(Math.abs(kernel.measureVolume(r.bodies[0].shape)-Math.PI*100*5)<.1);
    assert.ok(meshDocument(r).bodies[0].edges.some(e=>e.appearance==='seam'));
  });
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
