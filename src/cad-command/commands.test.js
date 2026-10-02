import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyCad, validateCad } from '../cad-core/document.js';
import { geometrySelector, resolveReference, toggleReference } from '../cad-core/selectors.js';
import { validateCommands } from './schema.js';
import { executeCommands } from './executor.js';
import { createProposal, proposalDocument, resumedProposal, proposalIssue } from './proposals.js';
import { parseLocalCommand } from './parser.js';
import { interpretPrompt, createMockAdapter, createTransportAdapter } from '../ai-adapter/index.js';
import { parseModelJson, serializeModelJson } from '../model-json.js';

const base = () => executeCommands({ schemaVersion: 5, shapes: [] }, [{ operation: 'addExtrude', profile: { type: 'rectangle', width: 40, height: 30 }, distance: 10, origin: [0, 0, 0] }]);
const body = id => ({ featureId: id, entityType: 'body', entitySelector: { kind: 'body' } });
const selector = geometrySelector({ geometryType: 'PLANE', center: [0, 0, 10], size: [40, 30, 0], direction: [0, 0, 1] }, [[-20, -15, 0], [20, 15, 10]]);
const face = { featureId: 'extrude-1', entityType: 'face', entitySelector: selector };
const marked = (ref = face) => { const d = base(); d.cad.selectionGroups.red = [ref]; return d; };

test('local grammar handles colors, speech units, R/C and numeric transform without a transport', async () => {
  for (const [text, op, field, value] of [['赤を削除', 'removeSelected'], ['R3', 'fillet', 'radius', 3], ['緑だけR2', 'fillet', 'radius', 2], ['C1', 'chamfer', 'distance', 1], ['3mm', 'changeDistance', 'distance', 3], ['赤いところ3ミリ削って', 'extrudeSelectedFaces', 'distance', -3], ['5mm伸ばす', 'extrudeSelectedFaces', 'distance', 5], ['青をZ90度回転', 'transform']]) {
    const c = parseLocalCommand(text).commands[0]; assert.equal(c.operation, op, text); if (field) assert.equal(c[field], value, text);
  }
  let calls = 0;
  const result = await interpretPrompt(marked(), 'R3', { adapter: createTransportAdapter(() => { calls++; throw new Error(); }) });
  assert.equal(result.source, 'local'); assert.equal(calls, 0);
  assert.equal(parseLocalCommand('赤を緑まで伸ばして'), null);
  assert.equal(parseLocalCommand('反対'), null);
  assert.equal(parseLocalCommand('R2をR3にして', { featureId: 'fillet-1' }).commands[0].featureId, 'fillet-1');
});
test('plain Japanese example buttons and voice phrasing execute through the local pipeline', async () => {
  const examples = [
    ['赤いところを３ミリ削ってください', 'extrudeSelectedFaces', 'distance', -3],
    ['緑の面を5ミリ伸ばして', 'extrudeSelectedFaces', 'distance', 5],
    ['青の角を半径2ミリで丸めて', 'fillet', 'radius', 2],
    ['赤を1ミリ面取りして', 'chamfer', 'distance', 1],
    ['赤の厚さを3ミリにして', 'changeDistance', 'distance', 3],
    ['この部品を2ミリ薄くして', 'changeDistance', 'distance', -2],
    ['緑をX方向に5ミリ移動して', 'transform'],
    ['青をZ軸まわりに90度回して', 'transform'],
  ];
  for (const [text, operation, key, value] of examples) {
    const c = parseLocalCommand(text).commands[0];
    assert.equal(c.operation, operation, text); if (key) assert.equal(c[key], value, text);
  }
  assert.deepEqual(parseLocalCommand(examples[6][0]).commands[0].translation, [5, 0, 0]);
  assert.deepEqual(parseLocalCommand(examples[7][0]).commands[0].rotation, [0, 0, 90]);
  const result = await interpretPrompt(marked(body('extrude-1')), '赤の厚さを3ミリにして', {
    adapter: createTransportAdapter(() => { throw new Error('local numeric edits must not call AI'); }),
  });
  assert.equal(result.source, 'local');
  assert.equal(proposalDocument(marked(body('extrude-1')), result.proposal).cad.features[0].distance, 3);
  for (const text of ['赤を少しだけ削って', '緑のように角を丸めて', '赤を緑まで伸ばして']) assert.equal(parseLocalCommand(text), null);
});
test('commands reject executable code, unknown operations and malformed values atomically', () => {
  for (const c of [{ operation: 'eval', code: 'alert(1)' }, { operation: 'fillet', selectionGroup: 'red', radius: 3, code: 'x' }, { operation: 'transform', selectionGroup: 'red', translation: [1, 2], rotation: [0, 0, 0] }, { operation: 'changeDistance', selectionGroup: 'purple', distance: 3 }, { operation: 'fillet', selectionGroup: 'red', radius: -3 }]) assert.throws(() => validateCommands([c]));
  const original = marked();
  assert.throws(() => executeCommands(original, [{ operation: 'fillet', selectionGroup: 'red', radius: 3 }, { operation: 'modifyFeature', featureId: 'extrude-1', changes: { distance: 0 } }]));
  assert.equal(original.cad.features.length, 1);
});
test('feature deletion cascades dependencies and removes marks, without deleting other bodies', () => {
  let d = marked();
  d = executeCommands(d, [{ operation: 'fillet', selectionGroup: 'red', radius: 2 }, { operation: 'addExtrude', profile: { type: 'circle', radius: 5 }, distance: 10, origin: [80, 0, 0] }]);
  d.cad.selectionGroups.green = [body('fillet-1')];
  const deleted = executeCommands(d, [{ operation: 'removeFeature', featureId: 'extrude-1' }]);
  assert.deepEqual(deleted.cad.features.map(f => f.id), ['extrude-2']);
  assert.equal(deleted.cad.selectionGroups.red.length, 0); assert.equal(deleted.cad.selectionGroups.green.length, 0);
  assert.throws(() => executeCommands(marked(), [{ operation: 'removeSelected', selectionGroup: 'red' }]), /部品/);
  assert.equal(executeCommands(marked(body('extrude-1')), [{ operation: 'removeSelected', selectionGroup: 'red' }]).cad.features.length, 0);
});
test('document extension preserves v5 models, selections and feature parameters through JSON', () => {
  const d = marked();
  assert.deepEqual(parseModelJson(serializeModelJson(d)), d);
  assert.deepEqual(parseModelJson('{"schemaVersion":5,"shapes":[]}'), { schemaVersion: 5, shapes: [] });
  for (const cad of [{ ...emptyCad(), schemaVersion: 99 }, { ...emptyCad(), features: [{ id: 'x', type: 'javascript' }] }, { ...emptyCad(), selectionGroups: { red: [{ ...face, entitySelector: { index: 7 } }], green: [], blue: [] } }]) assert.throws(() => parseModelJson(JSON.stringify({ shapes: [], cad })));
});
test('selectors survive order changes and reject ambiguous or missing geometry', () => {
  const candidate = { ...face, lineage: ['extrude-1'] };
  assert.equal(resolveReference(face, [body('other'), candidate]), candidate);
  assert.throws(() => resolveReference(face, []), /選び直/);
  assert.throws(() => resolveReference(face, [candidate, { ...candidate }]), /複数/);
  assert.deepEqual(toggleReference(toggleReference(emptyCad().selectionGroups, 'red', face), 'red', face), emptyCad().selectionGroups);
});
test('proposal rebases unrelated changes but protects edited target and retains live selection/view', () => {
  const d = marked();
  const p = createProposal(d, [{ operation: 'fillet', selectionGroup: 'red', radius: 2 }]);
  let live = executeCommands(d, [{ operation: 'addExtrude', profile: { type: 'circle', radius: 4 }, distance: 7, origin: [90, 0, 0] }]);
  live.rotation = { x: 45, y: 0, z: 0 }; live.cad.selectionGroups.red = []; live.cad.selectionGroups.green = [body('extrude-2')];
  const applied = proposalDocument(live, p);
  assert.equal(applied.cad.features.length, 3); assert.equal(applied.cad.features.at(-1).targets[0].featureId, 'extrude-1');
  assert.deepEqual(applied.cad.selectionGroups, live.cad.selectionGroups); assert.deepEqual(applied.rotation, live.rotation);
  live = executeCommands(live, [{ operation: 'modifyFeature', featureId: 'extrude-1', changes: { distance: 12 } }]);
  assert.throws(() => proposalDocument(live, p), /変更されました/);
});
test('mock uses a frozen snapshot, remains async, and returns unapplied commands', async () => {
  const d = marked();
  const promise = interpretPrompt(d, '少し丸く', { adapter: createMockAdapter({ delay: 20 }) });
  d.cad.selectionGroups.red = [];
  const result = await promise;
  assert.equal(result.source, 'ai'); assert.equal(d.cad.features.length, 1);
  assert.equal(result.proposal.selectionGroups.red.length, 1);
});
test('cancellation and clarification never mutate the model', async () => {
  const controller = new AbortController(), d = marked(), before = structuredClone(d);
  const promise = interpretPrompt(d, '少し丸く', { adapter: createMockAdapter({ delay: 100 }), signal: controller.signal });
  controller.abort(); await assert.rejects(promise, e => e.name === 'AbortError');
  const result = await interpretPrompt(d, 'ここと同じ感じ', { adapter: createMockAdapter({ delay: 0 }) });
  assert.ok(result.clarification); assert.deepEqual(d, before);
});
test('graph validation rejects duplicate ids, missing/consumed inputs and unsupported parameters', () => {
  const d = marked();
  assert.throws(() => validateCad({ ...d.cad, features: [...d.cad.features, ...d.cad.features] }));
  assert.throws(() => executeCommands(d, [{ operation: 'modifyFeature', featureId: 'extrude-1', changes: { radius: 3 } }]));
});

test('resumed sketch proposal previews its saved snapshot while a missing or changed local draft still blocks apply', () => {
  const original = marked();
  original.cad.draft.notes = '外径30 内径20 高さ30';
  const commands = [{ operation: 'addExtrude', profile: { type: 'circle', radius: 15 }, distance: 30, origin: [0,0,0] }];
  const p = resumedProposal({ task:'sketch', document:original, sketchDraft:original.cad.draft }, { commands, explanation:'保存された提案' });
  const fresh = { schemaVersion:5, shapes:[], cad:emptyCad() }, before = structuredClone(fresh);
  assert.equal(proposalDocument(p.previewSnapshot,p).cad.features.length, 2);
  assert.match(proposalIssue(fresh,p), /スケッチが変更/);
  assert.throws(() => proposalDocument(fresh,p), /スケッチが変更/);
  assert.deepEqual(fresh,before);
  const edited = structuredClone(original); edited.cad.draft.notes += ' 高さ40に変更';
  assert.match(proposalIssue(edited,p), /スケッチが変更/);
  assert.equal(proposalIssue(original,p), '');
  assert.equal(original.cad.features.length, 1);
});
test('resumed edit preview never bypasses a changed model target when applying', () => {
  const original = marked();
  const p = resumedProposal({task:'edit',document:original}, {commands:[{operation:'fillet',selectionGroup:'red',radius:2}]});
  const edited = executeCommands(original, [{operation:'modifyFeature',featureId:'extrude-1',changes:{distance:24}}]);
  assert.equal(proposalDocument(p.previewSnapshot,p).cad.features.length, 2);
  assert.match(proposalIssue(edited,p), /対象モデルが変更/);
  assert.throws(() => proposalDocument(edited,p), /対象モデルが変更/);
});
