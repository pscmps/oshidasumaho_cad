import { cadOf, nextFeatureId, PROJECTION_FEATURE_ID, validateCad } from '../cad-core/document.js';
import { validateCommands } from './schema.js';

function selected(cad, group) {
  const refs = cad.selectionGroups[group];
  if (!refs.length) throw new Error('3Dで対象を選択してください。');
  return refs;
}
export function activeTip(cad, id) {
  let next;
  while ((next = cad.features.find(f => f.input === id))) id = next.id;
  return id;
}
function roots(cad, refs) { return [...new Set(refs.map(r => activeTip(cad, r.featureId)))]; }
function remove(cad, id) {
  if (id !== PROJECTION_FEATURE_ID && !cad.features.some(f => f.id === id)) throw new Error('フィーチャーがありません。');
  const ids = new Set([id]);
  cad.features.forEach(f => { if (ids.has(f.input) || f.targets?.some(t => ids.has(t.featureId))) ids.add(f.id); });
  cad.features = cad.features.filter(f => !ids.has(f.id));
  if (id === PROJECTION_FEATURE_ID) cad.suppressedProjection = true;
  Object.keys(cad.selectionGroups).forEach(g => { cad.selectionGroups[g] = cad.selectionGroups[g].filter(r => !ids.has(r.featureId)); });
}

export function executeCommands(document, commands, { selectionGroups } = {}) {
  const result = structuredClone(document);
  const cad = structuredClone(cadOf(document));
  if (selectionGroups) cad.selectionGroups = structuredClone(selectionGroups);
  for (const c of validateCommands(commands)) {
    if (c.operation === 'removeFeature') { remove(cad, c.featureId); continue; }
    if (c.operation === 'modifyFeature') {
      const f = cad.features.find(f => f.id === c.featureId);
      if (!f) throw new Error('フィーチャーがありません。');
      const allowed = { extrude: ['distance'], faceExtrude: ['distance'], fillet: ['radius'], chamfer: ['distance'], transform: ['translation', 'rotation'] }[f.type];
      if (Object.keys(c.changes).some(k => !allowed.includes(k))) throw new Error('このフィーチャーの変更可能な値ではありません。');
      Object.assign(f, c.changes); continue;
    }
    if (c.operation === 'addExtrude') {
      cad.features.push({ id: nextFeatureId(cad, 'extrude'), type: 'extrude', profile: c.profile, distance: c.distance, origin: c.origin }); continue;
    }
    const refs = selected(cad, c.selectionGroup);
    if (c.operation === 'removeSelected') {
      if (refs.some(r => r.entityType !== 'body')) throw new Error('部品を消すには「部品」で選択してください。面をへこませる場合は「3ミリ削って」のように伝えてください。');
      // Body selection removes the producing root and its downstream operations.
      roots(cad, refs).forEach(id => {
        let f;
        while ((f = cad.features.find(f => f.id === id))?.input) id = f.input;
        remove(cad, id);
      });
    } else if (c.operation === 'changeDistance') {
      const producers = refs.map(({ featureId: id }) => {
        let f = cad.features.find(f => f.id === id);
        while (f?.input && !['extrude', 'faceExtrude'].includes(f.type)) f = cad.features.find(p => p.id === f.input);
        if (!f || !['extrude', 'faceExtrude'].includes(f.type)) throw new Error('押出フィーチャーを選択してください。3面投影の寸法は各面で編集します。');
        return f;
      });
      [...new Set(producers)].forEach(f => { f.distance = c.relative ? f.distance + c.distance : c.distance; });
    } else {
      roots(cad, refs).forEach(input => {
        const targets = refs.filter(r => activeTip(cad, r.featureId) === input);
        const type = { extrudeSelectedFaces: 'faceExtrude' }[c.operation] || c.operation;
        const f = { id: nextFeatureId(cad, type), type, input };
        if (type === 'transform') Object.assign(f, { translation: c.translation, rotation: c.rotation });
        else {
          if (targets.some(r => r.entityType === 'body' || (type === 'faceExtrude' && r.entityType !== 'face'))) throw new Error(type === 'faceExtrude' ? '「面」で選択してから、伸ばす量・削る量を伝えてください。' : '丸める場所を「面」か「ふち」で選択してください。');
          Object.assign(f, { targets, ...(type === 'fillet' ? { radius: c.radius } : { distance: c.distance }) });
        }
        cad.features.push(f);
      });
    }
  }
  validateCad(cad);
  // An async proposal's captured targets must not replace the user's newer marks.
  if (selectionGroups) {
    const ids = new Set([...(cad.suppressedProjection ? [] : [PROJECTION_FEATURE_ID]), ...cad.features.map(f => f.id)]);
    cad.selectionGroups = Object.fromEntries(Object.entries(cadOf(document).selectionGroups).map(([g, items]) => [g, items.filter(r => ids.has(r.featureId))]));
  }
  result.cad = cad;
  return result;
}
