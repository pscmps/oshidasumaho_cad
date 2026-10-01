import { GROUPS, validateReference } from './selectors.js';

export const CAD_SCHEMA_VERSION = 1;
export const PROJECTION_FEATURE_ID = 'projection-base';
export const FEATURE_TYPES = ['extrude', 'fillet', 'chamfer', 'transform', 'faceExtrude'];
export const emptyCad = () => ({ schemaVersion: CAD_SCHEMA_VERSION, features: [], selectionGroups: { red: [], green: [], blue: [] }, suppressedProjection: false });
const record = v => v && typeof v === 'object' && !Array.isArray(v);
const positive = v => Number.isFinite(v) && v > 0 && v <= 10000;
const vector = v => Array.isArray(v) && v.length === 3 && v.every(n => Number.isFinite(n) && Math.abs(n) <= 10000);
const keys = (v, allowed) => {
  if (!record(v) || Object.keys(v).some(k => !allowed.includes(k))) throw new Error('未対応のCADフィールドがあります。');
};

export function validateCad(cad) {
  keys(cad, ['schemaVersion', 'features', 'selectionGroups', 'suppressedProjection']);
  if (cad.schemaVersion !== CAD_SCHEMA_VERSION || !Array.isArray(cad.features) || cad.features.length > 500
    || typeof cad.suppressedProjection !== 'boolean') throw new Error('CAD documentのversionまたは構造が不正です。');
  const ids = new Set([PROJECTION_FEATURE_ID]);
  const tips = new Set(cad.suppressedProjection ? [] : [PROJECTION_FEATURE_ID]);
  for (const f of cad.features) {
    if (!record(f) || typeof f.id !== 'string' || !/^[\w-]{1,100}$/.test(f.id) || ids.has(f.id) || !FEATURE_TYPES.includes(f.type)) {
      throw new Error('フィーチャーのIDまたはtypeが不正です。');
    }
    if (f.type === 'extrude') {
      keys(f, ['id', 'type', 'profile', 'distance', 'origin']);
      if (!positive(Math.abs(f.distance)) || !vector(f.origin)) throw new Error('押出距離・位置が不正です。');
      if (f.profile?.type === 'rectangle') {
        keys(f.profile, ['type', 'width', 'height']);
        if (!positive(f.profile.width) || !positive(f.profile.height)) throw new Error('矩形寸法が不正です。');
      } else if (f.profile?.type === 'circle') {
        keys(f.profile, ['type', 'radius']);
        if (!positive(f.profile.radius)) throw new Error('円半径が不正です。');
      } else throw new Error('未対応の押出profileです。');
    } else {
      if (!tips.has(f.input)) throw new Error(`入力 ${f.input} は存在しないか、後続フィーチャーがあります。`);
      tips.delete(f.input);
      if (f.type === 'transform') {
        keys(f, ['id', 'type', 'input', 'translation', 'rotation']);
        if (!vector(f.translation) || !vector(f.rotation)) throw new Error('移動・回転値が不正です。');
      } else {
        const parameter = f.type === 'fillet' ? 'radius' : f.type === 'chamfer' ? 'distance' : 'distance';
        keys(f, ['id', 'type', 'input', 'targets', parameter]);
        if (!Array.isArray(f.targets) || !f.targets.length || f.targets.length > 200
          || !(f.type === 'faceExtrude' ? positive(Math.abs(f.distance)) : positive(f[parameter]))) throw new Error('対象または寸法が不正です。');
        f.targets.forEach(r => {
          validateReference(r);
          if (!ids.has(r.featureId) || r.entityType === 'body' || (f.type === 'faceExtrude' && r.entityType !== 'face')) throw new Error('対象entityが不正です。');
        });
      }
    }
    ids.add(f.id); tips.add(f.id);
  }
  keys(cad.selectionGroups, GROUPS);
  GROUPS.forEach(group => {
    const items = cad.selectionGroups[group];
    if (!Array.isArray(items) || items.length > 500) throw new Error('selection groupが不正です。');
    items.forEach(r => { validateReference(r); if (!ids.has(r.featureId)) throw new Error('選択の生成元がありません。'); });
  });
  return cad;
}

export function cadOf(document) { return document.cad || emptyCad(); }
export function geometryKey(document) {
  const cad = cadOf(document);
  return JSON.stringify([document.shapes, cad.features, cad.suppressedProjection]);
}
export function nextFeatureId(cad, type) {
  let i = 1;
  while (cad.features.some(f => f.id === `${type}-${i}`)) i++;
  return `${type}-${i}`;
}

export function featureTree(document) {
  const cad = cadOf(document);
  return [...(document.shapes?.length && !cad.suppressedProjection ? [{ id: PROJECTION_FEATURE_ID, type: 'projection', shapeIds: document.shapes.map(s => s.id) }] : []), ...cad.features];
}
