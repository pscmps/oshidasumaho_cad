import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyDraft, draftCommand, validateDraft, validateProfiles, dimensionHints } from './rough-sketch.js';
import { cadOf, emptyCad, validateCad, geometryKey } from './document.js';
import { executeCommands } from '../cad-command/executor.js';
import { createProposal, proposalDocument } from '../cad-command/proposals.js';
import { parseModelJson, serializeModelJson } from '../model-json.js';

const draft = () => {
  const d = emptyDraft();
  d.views.top.strokes = [{ id: 'outline', tool: 'rect', role: 'outline', points: [[0.1,0.2],[0.9,0.8]] }, { id: 'hole', tool: 'ellipse', role: 'cut', points: [[0.4,0.4],[0.6,0.6]] }];
  d.views.front.comments = [{ id: 'comment', position: [0.5,0.4], text: '厚さ3ミリ、ここに段差' }];
  return d;
};
test('rough sketch preserves strokes, holes, anchored comments and explicit mm through JSON', () => {
  const d = draft(), doc = { schemaVersion: 5, shapes: [], cad: { ...emptyCad(), draft: d } };
  const command = draftCommand(d); assert.equal(command.profiles.top.holes[0].type, 'ellipse');
  assert.deepEqual(command.profiles.top.outer.points, [[0,0],[1,0],[1,1],[0,1]]);
  assert.deepEqual(parseModelJson(serializeModelJson(doc)), doc);
  const model = executeCommands(doc, [command]); assert.equal(model.cad.features[0].type, 'sketchSolid');
  model.cad.selectionGroups.red = [{ featureId: 'sketchSolid-1', entityType: 'body', entitySelector: { kind: 'body' } }];
  assert.equal(executeCommands(model, [{ operation: 'changeDistance', selectionGroup: 'red', distance: 3 }]).cad.features[0].dimensions.height, 3);
});
test('v1 CAD migrates without replacing existing geometry; drafts do not trigger geometry rebuilds', () => {
  const legacy = { schemaVersion: 1, features: [], selectionGroups: { red: [], green: [], blue: [] }, suppressedProjection: false };
  validateCad(legacy); const upgraded = cadOf({ cad: legacy }); assert.equal(upgraded.schemaVersion, 2); assert.deepEqual(upgraded.features, legacy.features);
  assert.equal(legacy.schemaVersion, 1);
  const doc = { shapes: [], cad: { ...emptyCad(), draft: draft() } }, key = geometryKey(doc);
  doc.cad.draft.notes = '横幅80mm'; assert.equal(geometryKey(doc), key);
});
test('draft bounds, executable fields, intersecting contours and zero dimensions are rejected', () => {
  assert.throws(() => validateDraft({ ...draft(), javascript: 'bad' }));
  const d = draft(); d.views.top.strokes[0].points[0][0] = -1; assert.throws(() => validateDraft(d));
  assert.throws(() => validateProfiles({ top: { outer: { type: 'polygon', points: [[0,0],[1,1],[0,1],[1,0]] }, holes: [] } }));
  assert.throws(() => executeCommands({ shapes: [] }, [{ ...draftCommand(draft()), dimensions: { width: 0, depth: 50, height: 20 } }]));
  assert.deepEqual(dimensionHints('幅80mm 奥行き40ミリ 厚さ３ミリ'), { width:80, depth:40, height:3 });
});
test('changed sketch cannot receive an old proposal; unrelated model edits can rebase', () => {
  const doc = { shapes: [], cad: { ...emptyCad(), draft: draft() } };
  const p = createProposal(doc, [draftCommand(doc.cad.draft)]); p.draftKey = JSON.stringify(doc.cad.draft);
  const unrelated = executeCommands(doc, [{ operation:'addExtrude', profile:{type:'circle',radius:2},distance:3,origin:[100,0,0] }]);
  assert.equal(proposalDocument(unrelated,p).cad.features.length,2);
  unrelated.cad.draft.notes = '別の寸法'; assert.throws(() => proposalDocument(unrelated,p), /スケッチが変更/);
});
