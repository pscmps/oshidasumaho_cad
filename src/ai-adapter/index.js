import { parseLocalCommand } from '../cad-command/parser.js';
import { AI_COMMAND_CONTRACT, validateCommands } from '../cad-command/schema.js';
import { createProposal } from '../cad-command/proposals.js';
import { featureTree, cadOf } from '../cad-core/document.js';

export function createTransportAdapter(generate) {
  if (typeof generate !== 'function') throw new Error('AI transportが必要です。');
  return { propose: (request, options) => generate(request, options) };
}
// A Site host can inject its LLM transport; CAD never imports a vendor SDK.
export const createChatGPTSiteAdapter = createTransportAdapter;
export const offlineAdapter = {
  async propose() { return { clarification: 'ローカルで解釈できません。R3、3mm、X5mm移動などを使うか、AI adapterを接続してください。' }; },
};
export function createMockAdapter({ delay = 1200 } = {}) {
  return createTransportAdapter(async (request, { signal } = {}) => {
    await new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
      const aborted = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', aborted); resolve(); }, delay);
      signal?.addEventListener('abort', aborted, { once: true });
    });
    if (/少し丸く|丸くして/.test(request.prompt)) return { commands: [{ operation: 'fillet', selectionGroup: request.activeGroup, radius: 2 }], explanation: 'モック提案: 選択したEdge（Faceなら境界Edge）をR2にします。' };
    if (/逃がして/.test(request.prompt)) return { commands: [{ operation: 'chamfer', selectionGroup: request.activeGroup, distance: 1 }], explanation: 'モック提案: 選択したEdge（Faceなら境界Edge）をC1にします。' };
    return { clarification: 'モックは「少し丸く」「この辺を逃がして」に対応しています。寸法を指定する場合はローカルcommandを使えます。' };
  });
}

export async function interpretPrompt(document, prompt, { adapter = offlineAdapter, group = 'red', featureId, signal } = {}) {
  const snapshot = structuredClone(document);
  const local = parseLocalCommand(prompt, { group, featureId, featureType: cadOf(snapshot).features.find(f => f.id === featureId)?.type });
  if (local) return { source: 'local', proposal: createProposal(snapshot, local.commands) };
  const response = await adapter.propose({
    prompt, activeGroup: group, document: snapshot, features: featureTree(snapshot),
    selectionGroups: cadOf(snapshot).selectionGroups, contract: AI_COMMAND_CONTRACT,
  }, { signal });
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (response?.clarification && !response.commands) return { source: 'ai', clarification: String(response.clarification) };
  return { source: 'ai', proposal: createProposal(snapshot, validateCommands(response?.commands), String(response?.explanation || '')) };
}
