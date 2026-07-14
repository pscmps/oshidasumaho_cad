import {
  GEAR_MODULE_MAX,
  GEAR_MODULE_MIN,
  GEAR_TEETH_MAX,
  GEAR_TEETH_MIN,
  getGearBoreMax,
} from './gear-geometry.js';
import {
  RACK_HEIGHT_MAX,
  RACK_TEETH_MAX,
  RACK_TEETH_MIN,
  getRackGearDimensions,
} from './rack-gear-geometry.js';
import {
  INTERNAL_GEAR_TEETH_MAX,
  INTERNAL_GEAR_TEETH_MIN,
  getInternalGearMinimumOuterDiameter,
} from './internal-gear-geometry.js';
import { ceilToModelPrecision, normalizeModelPrecision } from './numeric-precision.js';

export const MODEL_SCHEMA_VERSION = 4;

const SUPPORTED_FACES = new Set(['top', 'front', 'right']);
const SUPPORTED_SHAPE_TYPES = new Set(['rect', 'circle', 'gear', 'rack', 'internalGear']);
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
  '- gearのx,yは中心、moduleはモジュール、teethは歯数、boreは中央穴径です。',
  '- rackのx,yは外接範囲の左上、moduleはモジュール、teethは歯数、heightは歯先から底面までの全高です。',
  '- internalGearのx,yは中心、moduleはモジュール、teethは歯数、outerDiameterは外径です。',
  '',
  '図形ルール:',
  '- typeはrect、circle、gear、rack、internalGearです。',
  '- modeはaddまたはcutです。',
  '- gearは通常の20度圧力角の平歯車で、modeはaddだけを指定してください。',
  '- gearのmoduleは0.5〜5、teethは8〜80の整数、boreは0以上で歯底径より小さくしてください。',
  '- rackは通常の20度圧力角のラックギヤで、modeはaddだけを指定してください。',
  '- rackのmoduleは0.5〜5、teethは1〜80の整数、heightは整数でmodule×2.25以上にしてください。',
  '- rackの幅はmodule×π×teethを小数第1位へ丸めた値です。左右端は歯底位置で終わります。',
  '- internalGearは通常の20度圧力角の内歯車で、modeはaddだけを指定してください。',
  '- internalGearのmoduleは0.5〜5、teethは34〜120の整数にしてください。',
  '- internalGearのouterDiameterは歯底円の外側に最低リム厚を確保し、0〜120の範囲内に収めてください。',
  '- 座標と寸法は小数第1位までにしてください。小数第2位以下は読み込み時に丸められます。',
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
  '- gearの外径はmodule×(teeth+2)です。外径全体が0〜120に収まるようにしてください。',
  '- rackはx〜x+module×π×teeth、y〜y+heightが0〜120に収まるようにしてください。',
  '- internalGearはx±outerDiameter/2、y±outerDiameter/2が0〜120に収まるようにしてください。',
  '- showDimensionsは各図形にfalseを指定してください。',
  '',
  'ロックルール:',
  '- AI生成時はareaLocksのtop/front/rightをすべてfalseにしてください。',
  '- areaLockConstraintsのtop/front/rightをすべてnullにしてください。',
  '- 読み込み後にユーザーが画面上で各面を確認してロックします。',
  '',
  '必須の基本構造:',
  '{',
  '  "schemaVersion": 4,',
  '  "partName": "internal-gear-part",',
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
  '    { "id": 1, "type": "internalGear", "x": 60, "y": 60, "module": 1, "teeth": 50, "outerDiameter": 68, "mode": "add", "face": "top", "showDimensions": false },',
  '    { "id": 2, "type": "rect", "x": 26, "y": 45, "w": 68, "h": 30, "mode": "add", "face": "front", "showDimensions": false },',
  '    { "id": 3, "type": "rect", "x": 26, "y": 45, "w": 68, "h": 30, "mode": "add", "face": "right", "showDimensions": false }',
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
    throw new ModelJsonError(`${path}.type はrect、circle、gear、rack、internalGearのいずれかである必要があります。`);
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
  } else if (shape.type === 'circle') {
    assertFiniteNumber(shape.r, `${path}.r`, { positive: true });
  } else if (shape.type === 'gear') {
    assertFiniteNumber(shape.module, `${path}.module`, { positive: true });
    assertFiniteNumber(shape.teeth, `${path}.teeth`, { positive: true });
    assertFiniteNumber(shape.bore, `${path}.bore`);
    if (shape.module < GEAR_MODULE_MIN || shape.module > GEAR_MODULE_MAX) {
      throw new ModelJsonError(`${path}.module は${GEAR_MODULE_MIN}〜${GEAR_MODULE_MAX}である必要があります。`);
    }
    if (!Number.isInteger(shape.teeth) || shape.teeth < GEAR_TEETH_MIN || shape.teeth > GEAR_TEETH_MAX) {
      throw new ModelJsonError(`${path}.teeth は${GEAR_TEETH_MIN}〜${GEAR_TEETH_MAX}の整数である必要があります。`);
    }
    if (shape.bore < 0 || shape.bore > getGearBoreMax(shape) + 0.001) {
      throw new ModelJsonError(`${path}.bore は0以上かつ歯底内に収まる直径である必要があります。`);
    }
    if (shape.mode !== 'add') {
      throw new ModelJsonError(`${path}.mode はgearの場合addである必要があります。`);
    }
  } else if (shape.type === 'rack') {
    assertFiniteNumber(shape.module, `${path}.module`, { positive: true });
    assertFiniteNumber(shape.teeth, `${path}.teeth`, { positive: true });
    assertFiniteNumber(shape.height, `${path}.height`, { positive: true });
    if (shape.module < GEAR_MODULE_MIN || shape.module > GEAR_MODULE_MAX) {
      throw new ModelJsonError(`${path}.module は${GEAR_MODULE_MIN}〜${GEAR_MODULE_MAX}である必要があります。`);
    }
    if (!Number.isInteger(shape.teeth) || shape.teeth < RACK_TEETH_MIN || shape.teeth > RACK_TEETH_MAX) {
      throw new ModelJsonError(`${path}.teeth は${RACK_TEETH_MIN}〜${RACK_TEETH_MAX}の整数である必要があります。`);
    }
    const { minimumHeight } = getRackGearDimensions(shape);
    if (!Number.isInteger(shape.height) || shape.height < minimumHeight || shape.height > RACK_HEIGHT_MAX) {
      throw new ModelJsonError(`${path}.height は${minimumHeight}〜${RACK_HEIGHT_MAX}の整数である必要があります。`);
    }
    if (shape.mode !== 'add') {
      throw new ModelJsonError(`${path}.mode はrackの場合addである必要があります。`);
    }
  } else {
    assertFiniteNumber(shape.module, `${path}.module`, { positive: true });
    assertFiniteNumber(shape.teeth, `${path}.teeth`, { positive: true });
    assertFiniteNumber(shape.outerDiameter, `${path}.outerDiameter`, { positive: true });
    if (shape.module < GEAR_MODULE_MIN || shape.module > GEAR_MODULE_MAX) {
      throw new ModelJsonError(`${path}.module は${GEAR_MODULE_MIN}〜${GEAR_MODULE_MAX}である必要があります。`);
    }
    if (
      !Number.isInteger(shape.teeth)
      || shape.teeth < INTERNAL_GEAR_TEETH_MIN
      || shape.teeth > INTERNAL_GEAR_TEETH_MAX
    ) {
      throw new ModelJsonError(
        `${path}.teeth は${INTERNAL_GEAR_TEETH_MIN}〜${INTERNAL_GEAR_TEETH_MAX}の整数である必要があります。`,
      );
    }
    const minimumOuterDiameter = ceilToModelPrecision(getInternalGearMinimumOuterDiameter(shape));
    if (shape.outerDiameter < minimumOuterDiameter - 0.001 || shape.outerDiameter > 120) {
      throw new ModelJsonError(
        `${path}.outerDiameter は${minimumOuterDiameter}〜120である必要があります。`,
      );
    }
    if (shape.mode !== 'add') {
      throw new ModelJsonError(`${path}.mode はinternalGearの場合addである必要があります。`);
    }
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

function migrateV1ToV2(document) {
  return { ...document, schemaVersion: 2 };
}

function migrateV2ToV3(document) {
  return { ...document, schemaVersion: 3 };
}

function migrateV3ToV4(document) {
  return { ...document, schemaVersion: 4 };
}

const MODEL_MIGRATIONS = new Map([
  [0, migrateV0ToV1],
  [1, migrateV1ToV2],
  [2, migrateV2ToV3],
  [3, migrateV3ToV4],
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

  const document = normalizeModelPrecision(migrateModelDocument(value, sourceVersion));
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
  const versionedDocument = normalizeModelPrecision({
    ...document,
    schemaVersion: MODEL_SCHEMA_VERSION,
  });
  return JSON.stringify(versionedDocument, null, space);
}

export async function readModelJsonFile(file) {
  if (!file || typeof file.text !== 'function') {
    throw new ModelJsonError('JSONファイルを選択してください。', 'FILE_REQUIRED');
  }
  return parseModelJson(await file.text());
}
