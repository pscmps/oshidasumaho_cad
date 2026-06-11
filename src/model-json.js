export const MODEL_SCHEMA_VERSION = 1;

const SUPPORTED_FACES = new Set(['top', 'front', 'right']);
const SUPPORTED_SHAPE_TYPES = new Set(['rect', 'circle']);
const SUPPORTED_SHAPE_MODES = new Set(['add', 'cut']);
const SUPPORTED_VIEW_MODES = new Set(['faces', '3d']);

export class ModelJsonError extends Error {
  constructor(message, code = 'INVALID_MODEL_JSON') {
    super(message);
    this.name = 'ModelJsonError';
    this.code = code;
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertRecord(value, path) {
  if (!isRecord(value)) {
    throw new ModelJsonError(`${path} はオブジェクトである必要があります。`);
  }
}

function assertFiniteNumber(value, path, { positive = false } = {}) {
  if (!Number.isFinite(value) || (positive && value <= 0)) {
    const condition = positive ? '0より大きい数値' : '有限の数値';
    throw new ModelJsonError(`${path} は${condition}である必要があります。`);
  }
}

function assertOptionalBoolean(value, path) {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new ModelJsonError(`${path} はtrueまたはfalseである必要があります。`);
  }
}

function validateRotation(rotation, path) {
  if (rotation === undefined) {
    return;
  }
  assertRecord(rotation, path);
  ['x', 'y', 'z'].forEach((axis) => {
    if (rotation[axis] !== undefined) {
      assertFiniteNumber(rotation[axis], `${path}.${axis}`);
    }
  });
}

function validateConstraint(constraint, path) {
  if (constraint === undefined || constraint === null) {
    return;
  }
  assertRecord(constraint, path);
  ['minX', 'maxX', 'minY', 'maxY'].forEach((key) => {
    if (constraint[key] !== undefined) {
      assertFiniteNumber(constraint[key], `${path}.${key}`);
    }
  });
  assertOptionalBoolean(constraint.constrainedX, `${path}.constrainedX`);
  assertOptionalBoolean(constraint.constrainedY, `${path}.constrainedY`);
}

function validateShape(shape, index, ids) {
  const path = `shapes[${index}]`;
  assertRecord(shape, path);
  assertFiniteNumber(shape.id, `${path}.id`);
  if (!Number.isInteger(shape.id) || shape.id < 0) {
    throw new ModelJsonError(`${path}.id は0以上の整数である必要があります。`);
  }
  if (ids.has(shape.id)) {
    throw new ModelJsonError(`${path}.id の値 ${shape.id} が重複しています。`);
  }
  ids.add(shape.id);

  if (!SUPPORTED_SHAPE_TYPES.has(shape.type)) {
    throw new ModelJsonError(`${path}.type はrectまたはcircleである必要があります。`);
  }
  if (!SUPPORTED_SHAPE_MODES.has(shape.mode)) {
    throw new ModelJsonError(`${path}.mode はaddまたはcutである必要があります。`);
  }
  if (!SUPPORTED_FACES.has(shape.face)) {
    throw new ModelJsonError(`${path}.face はtop、front、rightのいずれかである必要があります。`);
  }
  assertFiniteNumber(shape.x, `${path}.x`);
  assertFiniteNumber(shape.y, `${path}.y`);
  if (shape.type === 'rect') {
    assertFiniteNumber(shape.w, `${path}.w`, { positive: true });
    assertFiniteNumber(shape.h, `${path}.h`, { positive: true });
  } else {
    assertFiniteNumber(shape.r, `${path}.r`, { positive: true });
  }
  assertOptionalBoolean(shape.showDimensions, `${path}.showDimensions`);
}

function migrateV0ToV1(document) {
  const legacyActiveFace = document.activeFace === 'left'
    ? 'front'
    : document.activeFace || 'top';
  const migrated = {
    ...document,
    schemaVersion: 1,
    activeFace: legacyActiveFace,
  };
  if (Array.isArray(migrated.shapes)) {
    migrated.shapes = migrated.shapes.map((shape) => {
      if (!isRecord(shape)) {
        return shape;
      }
      const legacyFace = shape.face ?? legacyActiveFace;
      return {
        ...shape,
        face: legacyFace === 'left' ? 'front' : legacyFace,
      };
    });
  }
  return migrated;
}

const MODEL_MIGRATIONS = new Map([
  [0, migrateV0ToV1],
]);

function migrateModelDocument(document, sourceVersion) {
  let version = sourceVersion;
  let migrated = { ...document, schemaVersion: version };
  while (version < MODEL_SCHEMA_VERSION) {
    const migrate = MODEL_MIGRATIONS.get(version);
    if (!migrate) {
      throw new ModelJsonError(
        `version ${version} から移行する処理がありません。`,
        'MIGRATION_UNAVAILABLE',
      );
    }
    migrated = migrate(migrated);
    version = migrated.schemaVersion;
  }
  return migrated;
}

export function validateAndMigrateModelDocument(value) {
  assertRecord(value, 'JSON');

  const sourceVersion = value.schemaVersion ?? 0;
  if (!Number.isInteger(sourceVersion) || sourceVersion < 0) {
    throw new ModelJsonError('schemaVersion は0以上の整数である必要があります。', 'INVALID_VERSION');
  }
  if (sourceVersion > MODEL_SCHEMA_VERSION) {
    throw new ModelJsonError(
      `このJSONは新しい形式です（version ${sourceVersion}）。対応versionは ${MODEL_SCHEMA_VERSION} です。`,
      'UNSUPPORTED_VERSION',
    );
  }

  const document = migrateModelDocument(value, sourceVersion);
  if (!Array.isArray(document.shapes)) {
    throw new ModelJsonError('shapes は配列である必要があります。');
  }
  const ids = new Set();
  document.shapes.forEach((shape, index) => validateShape(shape, index, ids));

  if (document.activeFace !== undefined && !SUPPORTED_FACES.has(document.activeFace)) {
    throw new ModelJsonError('activeFace はtop、front、rightのいずれかである必要があります。');
  }
  if (document.viewMode !== undefined && !SUPPORTED_VIEW_MODES.has(document.viewMode)) {
    throw new ModelJsonError('viewMode はfacesまたは3dである必要があります。');
  }
  if (document.partName !== undefined && typeof document.partName !== 'string') {
    throw new ModelJsonError('partName は文字列である必要があります。');
  }
  if (document.extrude !== undefined) {
    assertFiniteNumber(document.extrude, 'extrude', { positive: true });
  }
  validateRotation(document.rotation, 'rotation');
  ['transparent3D', 'show3DGrid', 'show3DEdges', 'showAllDimensions'].forEach((key) => {
    assertOptionalBoolean(document[key], key);
  });

  if (document.areaLocks !== undefined) {
    assertRecord(document.areaLocks, 'areaLocks');
    [...SUPPORTED_FACES].forEach((face) => {
      assertOptionalBoolean(document.areaLocks[face], `areaLocks.${face}`);
    });
  }
  if (document.areaLockConstraints !== undefined) {
    assertRecord(document.areaLockConstraints, 'areaLockConstraints');
    [...SUPPORTED_FACES].forEach((face) => {
      validateConstraint(document.areaLockConstraints[face], `areaLockConstraints.${face}`);
    });
  }

  return {
    ...document,
    schemaVersion: MODEL_SCHEMA_VERSION,
  };
}

export function parseModelJson(text) {
  if (typeof text !== 'string') {
    throw new ModelJsonError('JSONデータは文字列である必要があります。');
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new ModelJsonError(`JSONの構文が正しくありません: ${error.message}`, 'INVALID_JSON_SYNTAX');
  }
  return validateAndMigrateModelDocument(value);
}

export function serializeModelJson(document, space = 2) {
  const versionedDocument = {
    ...document,
    schemaVersion: MODEL_SCHEMA_VERSION,
  };
  return JSON.stringify(versionedDocument, null, space);
}

export async function readModelJsonFile(file) {
  if (!file || typeof file.text !== 'function') {
    throw new ModelJsonError('JSONファイルを選択してください。', 'FILE_REQUIRED');
  }
  return parseModelJson(await file.text());
}
