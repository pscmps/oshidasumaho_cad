import { cadOf, geometryKey, validateCad } from '../cad-core/document.js';
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
    if (['addExtrude', 'addSketchSolid'].includes(c.operation)) return [];
    return c.featureId ? [root(cad, c.featureId)] : cad.selectionGroups[c.selectionGroup].map(r => root(cad, r.featureId));
  }))];
  const selectionGroups = structuredClone(cad.selectionGroups);
  const preview = executeCommands(snapshot, commands, { selectionGroups });
  return { commands, explanation, selectionGroups, roots, expected: scope(snapshot, roots), previewKey: geometryKey(preview) };
}
// Preview saved replies against their original snapshot without weakening apply guards.
export function resumedProposal(request, response, requestId) {
  const proposal = createProposal(request.document, response.commands, response.explanation || '保存された提案です');
  if (request.task === 'sketch') proposal.draftKey = JSON.stringify(request.sketchDraft);
  return { ...proposal, ...(requestId ? { requestId } : {}), previewSnapshot: request.document };
}
export function proposalIssue(current, proposal) {
  if (!proposal) return '';
  try { proposalDocument(current, proposal); return ''; } catch (error) { return error.message; }
}
export function proposalDocument(current, proposal) {
  if (proposal.requestId && cadOf(current).appliedRequestIds?.includes(proposal.requestId)) throw new Error('この依頼の提案は適用済みです。');
  if (proposal.draftKey && JSON.stringify(cadOf(current).draft) !== proposal.draftKey) throw new Error('依頼したスケッチが変更されています。新しいスケッチでもう一度依頼してください。');
  if (scope(current, proposal.roots) !== proposal.expected) throw new Error('待ち時間中に対象モデルが変更されました。現在のモデルでもう一度指示してください。');
  const result = executeCommands(current, proposal.commands, { selectionGroups: proposal.selectionGroups });
  if (proposal.requestId) {
    if (!/^[a-f0-9-]{36}$/.test(proposal.requestId)) throw new Error('提案の依頼番号が不正です。');
    const history = result.cad.appliedRequestIds || [];
    if (history.length >= 5000) throw new Error('この文書の提案適用履歴が上限に達しました。保存して新しい文書で続けてください。');
    result.cad.appliedRequestIds = [...history, proposal.requestId];
    validateCad(result.cad);
  }
  return result;
}
