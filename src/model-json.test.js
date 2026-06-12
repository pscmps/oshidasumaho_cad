import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_MODEL_JSON_PROMPT,
  MODEL_SCHEMA_VERSION,
  ModelJsonError,
  normalizeModelJsonText,
  parseModelJson,
  serializeModelJson,
} from './model-json.js';

const model = {
  schemaVersion: MODEL_SCHEMA_VERSION,
  partName: 'round-bracket',
  extrude: 12,
  activeFace: 'right',
  areaLocks: { top: true, front: true, right: true },
  areaLockConstraints: {
    top: { minX: 10, maxX: 80, minY: 10, maxY: 52, constrainedX: true, constrainedY: true },
    front: { minX: 10, maxX: 80, minY: 16, maxY: 70, constrainedX: true, constrainedY: true },
    right: { minX: 10, maxX: 52, minY: 16, maxY: 70, constrainedX: true, constrainedY: true },
  },
  viewMode: '3d',
  rotation: { x: 24, y: -34, z: 90 },
  transparent3D: false,
  show3DGrid: true,
  show3DEdges: true,
  showAllDimensions: true,
  shapes: [
    { id: 1, type: 'rect', x: 10, y: 10, w: 70, h: 42, mode: 'add', face: 'top', showDimensions: true },
    { id: 2, type: 'circle', x: 42, y: 31, r: 9, mode: 'cut', face: 'top', showDimensions: false },
  ],
};

test('saved JSON can be parsed without losing model fields', () => {
  assert.deepEqual(parseModelJson(serializeModelJson(model)), model);
});

test('legacy JSON without schemaVersion migrates to the current version', () => {
  const { schemaVersion, ...legacy } = model;
  const parsed = parseModelJson(JSON.stringify(legacy));
  assert.equal(parsed.schemaVersion, MODEL_SCHEMA_VERSION);
  assert.deepEqual(parsed.shapes, model.shapes);
});

test('explicit version 0 JSON follows the same migration path', () => {
  const parsed = parseModelJson(JSON.stringify({ ...model, schemaVersion: 0 }));
  assert.equal(parsed.schemaVersion, MODEL_SCHEMA_VERSION);
  assert.deepEqual(parsed.shapes, model.shapes);
});

test('legacy shapes without a face inherit activeFace', () => {
  const { schemaVersion, ...legacy } = model;
  const parsed = parseModelJson(JSON.stringify({
    ...legacy,
    activeFace: 'right',
    shapes: legacy.shapes.map(({ face, ...shape }) => shape),
  }));
  assert.ok(parsed.shapes.every((shape) => shape.face === 'right'));
});

test('invalid JSON syntax returns a model error', () => {
  assert.throws(
    () => parseModelJson('{invalid'),
    (error) => error instanceof ModelJsonError && error.code === 'INVALID_JSON_SYNTAX',
  );
});

test('JSON can be extracted from an AI markdown code block', () => {
  const fenced = `AI output:\n\n\`\`\`json\n${serializeModelJson(model)}\n\`\`\``;
  assert.deepEqual(parseModelJson(fenced), model);
});

test('smart double quotes are normalized before parsing', () => {
  const parsed = parseModelJson('{“schemaVersion”: 1, “shapes”: []}');
  assert.equal(parsed.schemaVersion, 1);
  assert.deepEqual(parsed.shapes, []);
});

test('plain markdown code fences and smart quotes are normalized together', () => {
  assert.equal(
    normalizeModelJsonText('  ```\n{“schemaVersion”: 1, “shapes”: []}\n```  '),
    '{"schemaVersion": 1, "shapes": []}',
  );
});

test('future schema versions are rejected clearly', () => {
  assert.throws(
    () => parseModelJson(JSON.stringify({ ...model, schemaVersion: MODEL_SCHEMA_VERSION + 1 })),
    (error) => error instanceof ModelJsonError && error.code === 'UNSUPPORTED_VERSION',
  );
});

test('invalid shape data is rejected', () => {
  const invalid = { ...model, shapes: [{ ...model.shapes[0], w: 0 }] };
  assert.throws(() => parseModelJson(JSON.stringify(invalid)), ModelJsonError);
});

test('AI prompt targets the current schema and safe JSON output rules', () => {
  assert.match(AI_MODEL_JSON_PROMPT, new RegExp(`"schemaVersion": ${MODEL_SCHEMA_VERSION}`));
  assert.match(AI_MODEL_JSON_PROMPT, /```json/);
  assert.match(AI_MODEL_JSON_PROMPT, /スマートクォート/);
  assert.match(AI_MODEL_JSON_PROMPT, /JSON\.parse/);
  assert.match(AI_MODEL_JSON_PROMPT, /末尾カンマ/);
  assert.match(AI_MODEL_JSON_PROMPT, /areaLocks/);
  assert.match(AI_MODEL_JSON_PROMPT, /topのy最小\/最大とrightのx最小\/最大/);
  assert.match(AI_MODEL_JSON_PROMPT, /extrudeは互換用フィールド/);
});
