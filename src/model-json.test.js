import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_MODEL_JSON_PROMPT,
  MODEL_SCHEMA_VERSION,
  ModelJsonError,
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

test('AI prompt targets the current schema and requests JSON-only output', () => {
  assert.match(AI_MODEL_JSON_PROMPT, new RegExp(`"schemaVersion": ${MODEL_SCHEMA_VERSION}`));
  assert.match(AI_MODEL_JSON_PROMPT, /JSON本体だけ/);
  assert.match(AI_MODEL_JSON_PROMPT, /areaLocks/);
});
