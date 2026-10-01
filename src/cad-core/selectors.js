// Persistent references describe geometry, never OpenCascade traversal indexes.
export const GROUPS = ['red', 'green', 'blue'];
const vector = v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
const rounded = v => v.map(n => Number(n.toFixed(5)));

export function validateReference(ref) {
  const s = ref?.entitySelector;
  if (!ref || typeof ref.featureId !== 'string' || !ref.featureId
    || !['body', 'face', 'edge'].includes(ref.entityType)
    || Object.keys(ref).some(k => !['featureId', 'entityType', 'entitySelector'].includes(k))) throw new Error('CAD entity参照が不正です。');
  if (ref.entityType === 'body') {
    if (s?.kind !== 'body' || Object.keys(s).length !== 1) throw new Error('Body selectorが不正です。');
    return;
  }
  if (s?.kind !== 'geometry' || s.version !== 1 || typeof s.geometryType !== 'string'
    || !vector(s.center) || !vector(s.size) || s.size.some(n => n < 0)
    || (s.direction !== null && !vector(s.direction))
    || !Number.isFinite(s.tolerance) || s.tolerance <= 0 || s.tolerance > 0.05
    || Object.keys(s).some(k => !['kind', 'version', 'geometryType', 'center', 'size', 'direction', 'tolerance'].includes(k))) {
    throw new Error('幾何selectorが不正です。index参照は使用できません。');
  }
}

export function geometrySelector(geometry, bodyBounds) {
  const [min, max] = bodyBounds;
  const span = max.map((v, i) => Math.max(v - min[i], 1e-6));
  return {
    kind: 'geometry', version: 1, geometryType: geometry.geometryType,
    center: rounded(geometry.center.map((v, i) => (v - min[i]) / span[i])),
    size: rounded(geometry.size.map((v, i) => v / span[i])),
    direction: geometry.direction ? rounded(geometry.direction) : null,
    tolerance: 0.015,
  };
}

export function selectorsMatch(a, b) {
  if (a.kind === 'body' || b.kind === 'body') return a.kind === b.kind;
  if (a.geometryType !== b.geometryType) return false;
  const tolerance = Math.min(a.tolerance, b.tolerance);
  if (!['center', 'size'].every(k => a[k].every((v, i) => Math.abs(v - b[k][i]) <= tolerance))) return false;
  return a.direction === null && b.direction === null
    || a.direction !== null && b.direction !== null
      && a.direction.every((v, i) => Math.abs(v - b.direction[i]) <= 0.01);
}

export function resolveReference(ref, candidates) {
  validateReference(ref);
  const matches = candidates.filter(c => c.entityType === ref.entityType
    && (c.featureId === ref.featureId || c.lineage?.includes(ref.featureId))
    && selectorsMatch(ref.entitySelector, c.entitySelector));
  if (matches.length !== 1) {
    throw new Error(matches.length ? '対象が複数あります。3Dで選び直してください。' : '対象の形状が変わりました。3Dで選び直してください。');
  }
  return matches[0];
}

export const referenceKey = ref => JSON.stringify([ref.featureId, ref.entityType, ref.entitySelector]);

export function toggleReference(groups, group, ref) {
  if (!GROUPS.includes(group)) throw new Error('選択グループが不正です。');
  validateReference(ref);
  const key = referenceKey(ref);
  const items = groups[group] || [];
  return { ...groups, [group]: items.some(r => referenceKey(r) === key)
    ? items.filter(r => referenceKey(r) !== key) : [...items, structuredClone(ref)] };
}
