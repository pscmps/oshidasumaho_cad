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
  fitAssist: true,
  shapes: [
    { id: 1, type: 'rect', x: 10, y: 10, w: 70, h: 42, mode: 'add', face: 'top', showDimensions: true },
    { id: 2, type: 'circle', x: 42, y: 31, r: 9, mode: 'cut', face: 'top', showDimensions: false },
    { id: 3, type: 'gear', x: 60, y: 60, module: 1, teeth: 24, bore: 6, mode: 'add', face: 'top', showDimensions: false },
    { id: 4, type: 'rack', x: 20, y: 70, module: 1, teeth: 20, width: 64.3, height: 10, rotation: 90, mode: 'add', face: 'top', showDimensions: false },
    { id: 5, type: 'internalGear', x: 60, y: 60, module: 1, teeth: 50, outerDiameter: 68, mode: 'add', face: 'top', showDimensions: false },
  ],
};

test('saved JSON can be parsed without losing model fields', () => {
  assert.deepEqual(parseModelJson(serializeModelJson(model)), model);
});

test('loaded and saved dimensions are normalized to one decimal place', () => {
  const preciseModel = {
    ...model,
    shapes: [
      { ...model.shapes[0], x: 10.044, w: 70.056 },
      { ...model.shapes[4], outerDiameter: 68.049 },
    ],
  };
  const parsed = parseModelJson(JSON.stringify(preciseModel));
  assert.equal(parsed.shapes[0].x, 10);
  assert.equal(parsed.shapes[0].w, 70.1);
  assert.equal(parsed.shapes[1].outerDiameter, 68);
  const saved = JSON.parse(serializeModelJson(preciseModel));
  assert.equal(saved.shapes[0].w, 70.1);
  assert.equal(saved.shapes[1].outerDiameter, 68);
});

test('legacy JSON without schemaVersion migrates to the current version', () => {
  const { schemaVersion, ...legacy } = model;
  const parsed = parseModelJson(JSON.stringify(legacy));
  assert.equal(parsed.schemaVersion, MODEL_SCHEMA_VERSION);
  assert.deepEqual(parsed.shapes, model.shapes);
});

test('fit assist is preserved when present and defaults in the application when omitted', () => {
  const disabled = parseModelJson(JSON.stringify({ ...model, fitAssist: false }));
  assert.equal(disabled.fitAssist, false);
  const { fitAssist, ...withoutFitAssist } = model;
  assert.equal(parseModelJson(JSON.stringify(withoutFitAssist)).fitAssist, undefined);
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
  assert.equal(parsed.schemaVersion, MODEL_SCHEMA_VERSION);
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

test('invalid gear parameters are rejected', () => {
  const gear = model.shapes.find((shape) => shape.type === 'gear');
  assert.throws(
    () => parseModelJson(JSON.stringify({ ...model, shapes: [{ ...gear, teeth: 7 }] })),
    ModelJsonError,
  );
  assert.throws(
    () => parseModelJson(JSON.stringify({ ...model, shapes: [{ ...gear, mode: 'cut' }] })),
    ModelJsonError,
  );
});

test('rack requires integer teeth, bounded dimensions, and add mode', () => {
  const rack = model.shapes.find((shape) => shape.type === 'rack');
  assert.throws(
    () => parseModelJson(JSON.stringify({ ...model, shapes: [{ ...rack, teeth: 20.5 }] })),
    ModelJsonError,
  );
  assert.throws(
    () => parseModelJson(JSON.stringify({ ...model, shapes: [{ ...rack, height: 2 }] })),
    ModelJsonError,
  );
  assert.throws(
    () => parseModelJson(JSON.stringify({ ...model, shapes: [{ ...rack, width: 60 }] })),
    ModelJsonError,
  );
  assert.throws(
    () => parseModelJson(JSON.stringify({ ...model, shapes: [{ ...rack, width: 100 }] })),
    ModelJsonError,
  );
  assert.throws(
    () => parseModelJson(JSON.stringify({ ...model, shapes: [{ ...rack, rotation: 45 }] })),
    ModelJsonError,
  );
  assert.throws(
    () => parseModelJson(JSON.stringify({ ...model, shapes: [{ ...rack, mode: 'cut' }] })),
    ModelJsonError,
  );
  const decimalHeight = parseModelJson(JSON.stringify({
    ...model,
    shapes: [{ ...rack, height: 10.3 }],
  }));
  assert.equal(decimalHeight.shapes[0].height, 10.3);
});

test('version 4 racks gain nominal width and zero rotation', () => {
  const rack = model.shapes.find((shape) => shape.type === 'rack');
  const { width, rotation, ...legacyRack } = rack;
  const parsed = parseModelJson(JSON.stringify({
    ...model,
    schemaVersion: 4,
    shapes: [legacyRack],
  }));

  assert.equal(parsed.schemaVersion, MODEL_SCHEMA_VERSION);
  assert.equal(parsed.shapes[0].width, 62.8);
  assert.equal(parsed.shapes[0].rotation, 0);
});

test('internal gear requires an involute-safe tooth count, rim, and add mode', () => {
  const internalGear = model.shapes.find((shape) => shape.type === 'internalGear');
  assert.throws(
    () => parseModelJson(JSON.stringify({ ...model, shapes: [{ ...internalGear, teeth: 33 }] })),
    ModelJsonError,
  );
  assert.throws(
    () => parseModelJson(JSON.stringify({ ...model, shapes: [{ ...internalGear, outerDiameter: 52.5 }] })),
    ModelJsonError,
  );
  assert.throws(
    () => parseModelJson(JSON.stringify({ ...model, shapes: [{ ...internalGear, mode: 'cut' }] })),
    ModelJsonError,
  );
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
  assert.match(AI_MODEL_JSON_PROMPT, /gearのmodule/);
  assert.match(AI_MODEL_JSON_PROMPT, /rackの最小幅/);
  assert.match(AI_MODEL_JSON_PROMPT, /rackのrotation/);
  assert.match(AI_MODEL_JSON_PROMPT, /internalGearのouterDiameter/);
  assert.match(AI_MODEL_JSON_PROMPT, /"fitAssist": true/);
});
