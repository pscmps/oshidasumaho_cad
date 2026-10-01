import { cadOf, geometryKey } from '../cad-core/document.js';
import { executeCommands } from './executor.js';
import { validateCommands } from './schema.js';

function root(cad, id) {
  let f;
  while ((f = cad.features.find(f => f.id === id))?.input) id = f.input;
  return id;
}
function scope(document, roots) {
  const cad = cadOf(document);
  return JSON.stringify({
    projection: roots.includes('projection-base') ? [document.shapes, cad.suppressedProjection] : undefined,
    features: cad.features.filter(f => roots.includes(root(cad, f.id))),
  });
}
export function createProposal(snapshot, commands, explanation = '') {
  commands = validateCommands(commands);
  const cad = cadOf(snapshot);
  const roots = [...new Set(commands.flatMap(c => {
    if (c.operation === 'addExtrude') return [];
    return c.featureId ? [root(cad, c.featureId)] : cad.selectionGroups[c.selectionGroup].map(r => root(cad, r.featureId));
  }))];
  const selectionGroups = structuredClone(cad.selectionGroups);
  const preview = executeCommands(snapshot, commands, { selectionGroups });
  return { commands, explanation, selectionGroups, roots, expected: scope(snapshot, roots), previewKey: geometryKey(preview) };
}
export function proposalDocument(current, proposal) {
  if (scope(current, proposal.roots) !== proposal.expected) throw new Error('待ち時間中に対象モデルが変更されました。現在のモデルでもう一度指示してください。');
  return executeCommands(current, proposal.commands, { selectionGroups: proposal.selectionGroups });
}
