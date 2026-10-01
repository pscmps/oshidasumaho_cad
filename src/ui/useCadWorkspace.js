import { useEffect, useRef, useState } from 'react';
import { cadOf, geometryKey } from '../cad-core/document.js';
import { referenceKey, toggleReference } from '../cad-core/selectors.js';
import { evaluateInWorker } from '../cad-core/client.js';
import { createProposal, proposalDocument } from '../cad-command/proposals.js';
import { CAD_COMMAND_SCHEMA } from '../cad-command/schema.js';
import { interpretPrompt, offlineAdapter, createMockAdapter } from '../ai-adapter/index.js';

export function useCadWorkspace(document, setDocument, enabled) {
  const latest = useRef(document); latest.current = document;
  const request = useRef(), sequence = useRef(0), meshSequence = useRef(0);
  const [mesh, setMesh] = useState(null), [ghost, setGhost] = useState(null);
  const [group, setGroup] = useState('red'), [mode, setMode] = useState('face'), [paint, setPaint] = useState(false);
  const [proposal, setProposal] = useState(null), [pending, setPending] = useState(false);
  const [status, setStatus] = useState(''), [meshStatus, setMeshStatus] = useState('');
  const [adapterMode, setAdapterMode] = useState('offline'), [selectedFeatureId, setSelectedFeatureId] = useState('');
  const undo = useRef([]);
  const key = geometryKey(document);

  useEffect(() => {
    if (!enabled) return;
    const n = ++meshSequence.current;
    setMeshStatus('形状を生成中… 操作は続けられます');
    evaluateInWorker(latest.current).then(result => {
      if (n !== meshSequence.current) return;
      setMesh(result); setMeshStatus(result.bodies.length ? '' : '3面の外形を揃えるか、四角柱を追加してください');
    }).catch(e => { if (n === meshSequence.current) { setMesh(null); setMeshStatus(e.message); } });
    return () => { meshSequence.current++; };
  }, [key, enabled]);

  useEffect(() => {
    if (!proposal || !enabled) { setGhost(null); return; }
    let cancelled = false;
    let candidate;
    try { candidate = proposalDocument(latest.current, proposal); }
    catch (e) { setGhost(null); setStatus(e.message); return; }
    evaluateInWorker(candidate).then(result => { if (!cancelled) setGhost(result); })
      .catch(e => { if (!cancelled) { setGhost(null); setStatus(`提案を生成できません: ${e.message}`); } });
    return () => { cancelled = true; };
  }, [proposal, key, enabled]);
  useEffect(() => () => { request.current?.abort(); sequence.current++; }, []);

  useEffect(() => {
    const context = window.document.modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    const register = tool => {
      try { Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(() => {}); }
      catch { /* optional browser capability */ }
    };
    register({ name: 'read_cad_document', description: 'Read the structured CAD model and red/green/blue entity groups.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true },
      execute: input => { if (Object.keys(input || {}).length) throw new Error('入力は空objectです。'); return structuredClone(latest.current); } });
    register({ name: 'stage_cad_commands', description: 'Validate CAD commands and show an unapplied ghost proposal for user review.',
      inputSchema: { type: 'object', properties: { commands: { type: 'array', minItems: 1, maxItems: 20, items: CAD_COMMAND_SCHEMA } }, required: ['commands'], additionalProperties: false }, annotations: { readOnlyHint: false },
      async execute(input) {
        if (!input || Object.keys(input).some(k => k !== 'commands')) throw new Error('commandsが必要です。');
        const p = createProposal(latest.current, input.commands, '構造化commandによる提案');
        const preview = await evaluateInWorker(proposalDocument(latest.current, p));
        proposalDocument(latest.current, p); setProposal(p); setGhost(preview);
        return { status: 'staged', commands: p.commands };
      } });
    return () => lifecycle.abort();
  }, []);

  async function apply(p) {
    // Validate geometry off the UI thread, then apply the diff to the latest doc.
    for (let i = 0; i < 3; i++) {
      const candidate = proposalDocument(latest.current, p);
      await evaluateInWorker(candidate);
      const current = latest.current;
      const rebased = proposalDocument(current, p);
      if (geometryKey(candidate) !== geometryKey(rebased)) continue;
      undo.current.push({ key: geometryKey(rebased), cad: structuredClone(cadOf(current)) });
      undo.current = undo.current.slice(-20);
      latest.current = rebased; setDocument(rebased); setProposal(null); setGhost(null);
      setStatus('変更を適用しました'); return;
    }
    throw new Error('モデルが更新されています。もう一度適用してください。');
  }
  async function submit(prompt) {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    const n = ++sequence.current; setStatus('指示を解釈しています'); setPending(true);
    try {
      const adapter = adapterMode === 'mock' ? createMockAdapter() : adapterMode === 'connected' ? window.oshidaCadAIAdapter : offlineAdapter;
      const result = await interpretPrompt(latest.current, prompt, { adapter, group, featureId: selectedFeatureId, signal: controller.signal });
      if (n !== sequence.current) return;
      if (result.clarification) { setStatus(result.clarification); return; }
      if (result.source === 'local') { await apply(result.proposal); }
      else { setProposal(result.proposal); setStatus('提案が届きました。ゴーストを確認して適用してください。'); }
    } catch (e) { if (n === sequence.current && e.name !== 'AbortError') setStatus(e.message); }
    finally { if (n === sequence.current) setPending(false); }
  }
  const runCommands = async commands => {
    try { await apply(createProposal(latest.current, commands)); } catch (e) { setStatus(e.message); }
  };

  return {
    mesh, ghost, group, setGroup, mode, setMode, paint, setPaint, proposal, pending, status, meshStatus,
    adapterMode, setAdapterMode, selectedFeatureId, setSelectedFeatureId, submit, runCommands,
    groups: cadOf(document).selectionGroups,
    select(ref, brush = false) {
      setDocument(current => {
        const cad = cadOf(current);
        if (brush && cad.selectionGroups[group].some(r => referenceKey(r) === referenceKey(ref))) return current;
        return { ...current, cad: { ...cad, selectionGroups: toggleReference(cad.selectionGroups, group, ref) } };
      });
    },
    clearGroup() { setDocument(current => ({ ...current, cad: { ...cadOf(current), selectionGroups: { ...cadOf(current).selectionGroups, [group]: [] } } })); },
    cancel() { request.current?.abort(); sequence.current++; setPending(false); setProposal(null); setGhost(null); setStatus('キャンセルしました'); },
    async applyProposal() { try { await apply(proposal); } catch (e) { setStatus(e.message); } },
    undo() {
      const last = undo.current.at(-1);
      if (!last) { setStatus('戻せるcommandがありません'); return; }
      if (geometryKey(latest.current) !== last.key) { setStatus('他のモデル編集があるため戻せません'); return; }
      undo.current.pop(); setDocument(current => ({ ...current, cad: last.cad })); setProposal(null); setGhost(null); setStatus('前のcommandを戻しました');
    },
  };
}
