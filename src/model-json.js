export const MODEL_SCHEMA_VERSION = 1;

const SUPPORTED_FACES = new Set(['top', 'front', 'right']);
const SUPPORTED_SHAPE_TYPES = new Set(['rect', 'circle']);
const SUPPORTED_SHAPE_MODES = new Set(['add', 'cut']);
const SUPPORTED_VIEW_MODES = new Set(['faces', '3d']);

export const AI_MODEL_JSON_PROMPT = [
  'オシダスマホキャドで読み込めるJSONを作成してください。',
  '',
  '出力形式:',
  '- JSONは必ず ```json で始まるコードブロック内に出力してください。',
  '- コードブロック内にはJSON以外の文章を含めないでください。',
  '- 説明文が不要な場合は、コードブロック以外を出力しないでください。',
  '- 説明文を書く場合も、JSONコードブロックの外側だけに書いてください。',
  '',
  '文字制約:',
  '- JSON内ではASCII文字だけを使用してください。',
  '- キーと文字列を囲む引用符はASCIIのダブルクォート "（U+0022）だけを使用してください。',
  "- ASCIIのシングルクォート '（U+0027）は文字列内の文字としてのみ使用できます。JSONの区切りには使用しないでください。",
  '- スマートクォート “ ” ‘ ’ は絶対に使用しないでください。',
  '- partNameなどの文字列値も英数字、空白、ハイフンなどのASCII文字で記述してください。',
  '',
  '出力前の妥当性確認:',
  '- JSON.parseできる構文であることを確認してください。',
  '- 末尾カンマを付けないでください。',
  '- 数値を引用符で囲まず、数値型として出力してください。',
  '- true、false、nullは必ず小文字で出力してください。',
  '- UTF-8テキストとして保存可能であることを確認してください。',
  '',
  '座標系と面:',
  '- 全面とも編集範囲は0〜120です。',
  '- top（上面）: x=幅、y=奥行き',
  '- front（正面）: x=幅、y=高さ',
  '- right（右側面）: x=奥行き、y=高さ',
  '- rectのx,yは左上、w,hは幅と高さです。',
  '- circleのx,yは中心、rは半径です。',
  '',
  '図形ルール:',
  '- typeはrectまたはcircleです。',
  '- modeはaddまたはcutです。',
  '- shapesは上から順番に評価され、後のaddは前のcutを上書きできます。',
  '- idはJSON内で重複しない0以上の整数にしてください。',
  '- 各面に外形を決めるadd図形を最低1個置いてください。',
  '- 3面の共有軸はサイズだけでなく開始座標と終了座標を完全に一致させてください。',
  '- topのx最小/最大とfrontのx最小/最大を一致させてください（幅）。',
  '- topのy最小/最大とrightのx最小/最大を一致させてください（奥行）。',
  '- frontのy最小/最大とrightのy最小/最大を一致させてください（高さ）。',
  '- 外接範囲はadd/cutを順番に適用した最終形状から計算してください。',
  '- topが円形や8の字でもfront/rightは矩形で構いませんが、共有軸の外接範囲は一致が必要です。',
  '- extrudeは互換用フィールドであり、奥行や3D寸法の指定には使用されません。',
  '- 奥行はtopのy範囲とrightのx範囲で表現してください。',
  '- rectはx〜x+w、y〜y+hが0〜120に収まるようにしてください。',
  '- circleはx-r〜x+r、y-r〜y+rが0〜120に収まるようにしてください。',
  '- showDimensionsは各図形にfalseを指定してください。',
  '',
  'ロックルール:',
  '- AI生成時はareaLocksのtop/front/rightをすべてfalseにしてください。',
  '- areaLockConstraintsのtop/front/rightをすべてnullにしてください。',
  '- 読み込み後にユーザーが画面上で各面を確認してロックします。',
  '',
  '必須の基本構造:',
  '{',
  '  "schemaVersion": 1,',
  '  "partName": "部品名",',
  '  "extrude": 12,',
  '  "activeFace": "top",',
  '  "areaLocks": { "top": false, "front": false, "right": false },',
  '  "areaLockConstraints": { "top": null, "front": null, "right": null },',
  '  "viewMode": "faces",',
  '  "rotation": { "x": 24, "y": -34, "z": 0 },',
  '  "transparent3D": true,',
  '  "show3DGrid": false,',
  '  "show3DEdges": true,',
  '  "showAllDimensions": false,',
  '  "shapes": [',
  '    { "id": 1, "type": "rect", "x": 20, "y": 20, "w": 60, "h": 40, "mode": "add", "face": "top", "showDimensions": false },',
  '    { "id": 2, "type": "circle", "x": 50, "y": 40, "r": 5, "mode": "cut", "face": "top", "showDimensions": false },',
  '    { "id": 3, "type": "rect", "x": 20, "y": 30, "w": 60, "h": 30, "mode": "add", "face": "front", "showDimensions": false },',
  '    { "id": 4, "type": "rect", "x": 20, "y": 30, "w": 40, "h": 30, "mode": "add", "face": "right", "showDimensions": false }',
  '  ]',
  '}',
  '',
  '上のshapesは形式例です。構造を保ったまま、次の要件に合う図形へ置き換えてください。',
  '作りたい部品の要件:',
  '（ここに寸法、穴径、形状、用途などを記入）',
].join('\n');

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
  const jsonText = normalizeModelJsonText(text);
  let value;
  try {
    value = JSON.parse(jsonText);
  } catch (error) {
    throw new ModelJsonError(`JSONの構文が正しくありません: ${error.message}`, 'INVALID_JSON_SYNTAX');
  }
  return validateAndMigrateModelDocument(value);
}

export function normalizeModelJsonText(text) {
  if (typeof text !== 'string') {
    throw new ModelJsonError('JSONデータは文字列である必要があります。');
  }
  const fencedJson = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fencedJson ? fencedJson[1] : text)
    .trim()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");
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
