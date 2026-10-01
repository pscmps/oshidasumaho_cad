import { GROUPS } from '../cad-core/selectors.js';

export const OPERATIONS = ['removeFeature', 'removeSelected', 'modifyFeature', 'changeDistance', 'fillet', 'chamfer', 'transform', 'extrudeSelectedFaces', 'addExtrude'];
const object = v => v && typeof v === 'object' && !Array.isArray(v);
const number = v => Number.isFinite(v) && Math.abs(v) <= 10000;
const vector = v => Array.isArray(v) && v.length === 3 && v.every(number);
const fields = {
  removeFeature: ['featureId'], removeSelected: ['selectionGroup'], modifyFeature: ['featureId', 'changes'],
  changeDistance: ['selectionGroup', 'distance', 'relative'], fillet: ['selectionGroup', 'radius'],
  chamfer: ['selectionGroup', 'distance'], transform: ['selectionGroup', 'translation', 'rotation'],
  extrudeSelectedFaces: ['selectionGroup', 'distance'], addExtrude: ['profile', 'distance', 'origin'],
};

export function validateCommand(c) {
  if (!object(c) || !OPERATIONS.includes(c.operation)
    || Object.keys(c).some(k => k !== 'operation' && !fields[c.operation].includes(k))) throw new Error('許可されたCAD commandだけを実行できます。');
  if (fields[c.operation].includes('selectionGroup') && !GROUPS.includes(c.selectionGroup)) throw new Error('赤・緑・青のグループを指定してください。');
  if (fields[c.operation].includes('featureId') && (typeof c.featureId !== 'string' || !c.featureId)) throw new Error('featureIdが必要です。');
  if (fields[c.operation].includes('distance') && (!number(c.distance) || c.distance === 0)) throw new Error('0以外の距離が必要です。');
  if (c.operation === 'fillet' && (!number(c.radius) || c.radius <= 0)) throw new Error('正のR値が必要です。');
  if (c.operation === 'chamfer' && c.distance <= 0) throw new Error('正の面取り値が必要です。');
  if (c.relative !== undefined && typeof c.relative !== 'boolean') throw new Error('relativeはbooleanです。');
  if (c.operation === 'transform' && (!vector(c.translation) || !vector(c.rotation))) throw new Error('XYZ移動・回転を指定してください。');
  if (c.operation === 'modifyFeature') {
    if (!object(c.changes) || !Object.keys(c.changes).length || Object.keys(c.changes).some(k => !['radius', 'distance', 'translation', 'rotation'].includes(k))) throw new Error('変更可能なパラメータだけを指定してください。');
    Object.entries(c.changes).forEach(([k, v]) => { if (['translation', 'rotation'].includes(k) ? !vector(v) : !number(v)) throw new Error('パラメータ値が不正です。'); });
  }
  if (c.operation === 'addExtrude' && (!object(c.profile) || !vector(c.origin))) throw new Error('profileとoriginが必要です。');
  return structuredClone(c);
}

export function validateCommands(value) {
  if (!Array.isArray(value) || !value.length || value.length > 20) throw new Error('commandは1〜20件の配列で指定してください。');
  return value.map(validateCommand);
}

const numericSchema = { type: 'number', minimum: -10000, maximum: 10000 };
const positiveSchema = { type: 'number', exclusiveMinimum: 0, maximum: 10000 };
const vectorSchema = { type: 'array', items: numericSchema, minItems: 3, maxItems: 3 };
const profileSchema = { oneOf: [
  { type: 'object', properties: { type: { const: 'rectangle' }, width: positiveSchema, height: positiveSchema }, required: ['type', 'width', 'height'], additionalProperties: false },
  { type: 'object', properties: { type: { const: 'circle' }, radius: positiveSchema }, required: ['type', 'radius'], additionalProperties: false },
] };
export const CAD_COMMAND_SCHEMA = { oneOf: OPERATIONS.map(operation => ({
  type: 'object', additionalProperties: false,
  required: ['operation', ...fields[operation].filter(k => k !== 'relative')],
  properties: {
    operation: { const: operation },
    ...Object.fromEntries(fields[operation].map(k => [k, {
      featureId: { type: 'string', minLength: 1, maxLength: 100 },
      selectionGroup: { enum: GROUPS },
      radius: positiveSchema, distance: operation === 'chamfer' ? positiveSchema : { ...numericSchema, not: { const: 0 } },
      relative: { type: 'boolean' }, translation: vectorSchema, rotation: vectorSchema, origin: vectorSchema,
      profile: profileSchema,
      changes: { type: 'object', minProperties: 1, additionalProperties: false, properties: { radius: positiveSchema, distance: { ...numericSchema, not: { const: 0 } }, translation: vectorSchema, rotation: vectorSchema } },
    }[k]])),
  },
})) };

// Transport-neutral contract for adapters. Runtime validation above is authoritative.
export const AI_COMMAND_CONTRACT = {
  commandSchema: CAD_COMMAND_SCHEMA,
  response: { commands: 'CAD command[] (1..20)', explanation: 'string', clarification: 'string (no commands when asking)' },
  operations: fields,
  units: { distance: 'mm', radius: 'mm', translation: '[x,y,z] mm', rotation: '[x,y,z] degrees' },
  rules: ['Use supplied entity references and feature IDs only.', 'No JavaScript, code, GUI actions or whole-document replacements.', 'Ask for clarification when intent or target is ambiguous.', 'removeSelected requires Body selection; face deletion is not supported.'],
};
