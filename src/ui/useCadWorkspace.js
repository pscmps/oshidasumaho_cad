import { useEffect, useRef, useState } from 'react';
import { cadOf, geometryKey } from '../cad-core/document.js';
import { referenceKey, toggleReference } from '../cad-core/selectors.js';
import { evaluateInWorker } from '../cad-core/client.js';
import { createProposal, proposalDocument } from '../cad-command/proposals.js';
import { CAD_COMMAND_SCHEMA, AI_COMMAND_CONTRACT, validateCommands } from '../cad-command/schema.js';
import { interpretPrompt, offlineAdapter, createMockAdapter } from '../ai-adapter/index.js';
import { createCodexAdapter } from '../ai-adapter/codex.js';
import { emptyDraft, draftCommand, validateDraft } from '../cad-core/rough-sketch.js';

export function useCadWorkspace(document, setDocument, enabled) {
  const latest = useRef(document); latest.current = document;
  const request = useRef(), sequence = useRef(0), meshSequence = useRef(0);
  const [mesh, setMesh] = useState(null), [ghost, setGhost] = useState(null);
  const [group, setGroup] = useState('red'), [mode, setMode] = useState('face'), [paint, setPaint] = useState(false);
  const [proposal, setProposal] = useState(null), [pending, setPending] = useState(false);
  const [status, setStatus] = useState(''), [meshStatus, setMeshStatus] = useState('');
  const [adapterMode, setAdapterMode] = useState(() => import.meta.env.VITE_SITE_CODEX === '1' ? 'codex' : window.oshidaCadAIAdapter?.propose ? 'connected' : 'offline'), [selectedFeatureId, setSelectedFeatureId] = useState('');
  const [requestId, setRequestId] = useState('');
  const undo = useRef([]);
  const key = geometryKey(document);
  const draft = cadOf(document).draft || emptyDraft(), draftKey = JSON.stringify(draft);

  useEffect(() => {
    if (!enabled) return;
    const n = ++meshSequence.current;
    setMeshStatus('形状を生成中… 操作は続けられます');
    evaluateInWorker(latest.current).then(result => {
      if (n !== meshSequence.current) return;
      setMesh(result); setMeshStatus(result.bodies.length ? '' : 'スケッチを描いてモデル化してください');
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
  }, [proposal, key, draftKey, enabled]);
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
      setRequestId('');
      const adapter = getAdapter(n);
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
  function getAdapter(n) {
    return adapterMode === 'codex' ? createCodexAdapter({ onQueued: id => { if (sequence.current === n) { setRequestId(id); setStatus('Codexへ依頼を置きました。Codexに「CADの最新依頼を確認してモデルを提案して」と伝えてください。'); } } })
      : adapterMode === 'mock' ? createMockAdapter() : adapterMode === 'connected' ? window.oshidaCadAIAdapter : offlineAdapter;
  }
  function sketchOrigin() {
    const bounds = mesh?.bodies.map(b => b.bounds[1][0]) || [];
    return [bounds.length ? Math.max(...bounds) + 10 : 0, 0, 0];
  }
  async function requestSketch() {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    const n = ++sequence.current; setPending(true); setRequestId(''); setStatus('スケッチを送っています');
    const snapshot = structuredClone(latest.current), sketchDraft = cadOf(snapshot).draft || emptyDraft();
    try {
      validateDraft(sketchDraft);
      if (!Object.values(sketchDraft.views).some(v => v.strokes.length) && !sketchDraft.notes.trim()) throw new Error('外形を描くか、作りたい部品を説明してください');
      const response = await getAdapter(n).propose({ task: 'sketch', prompt: `${sketchDraft.notes || '描いたスケッチを部品にしてください'}\n追加位置の目安: ${JSON.stringify(sketchOrigin())} mm`, document: snapshot, sketchDraft, contract: AI_COMMAND_CONTRACT }, { signal: controller.signal });
      if (n !== sequence.current) return;
      if (response?.clarification && !response.commands) { setStatus(String(response.clarification)); return; }
      const p = createProposal(snapshot, validateCommands(response?.commands), String(response?.explanation || 'スケッチからの提案です'));
      p.draftKey = JSON.stringify(sketchDraft); proposalDocument(latest.current, p);
      setProposal(p); setStatus('Codexの提案が届きました。立体を確認して適用してください');
    } catch (e) { if (n === sequence.current && e.name !== 'AbortError') setStatus(e.message); }
    finally { if (n === sequence.current) setPending(false); }
  }
  async function previewSketch() {
    try {
      const snapshot = structuredClone(latest.current), d = cadOf(snapshot).draft || emptyDraft();
      const p = createProposal(snapshot, [draftCommand(d, sketchOrigin())], '描いた外形と穴から作った形です。コメントはまだ解釈していません。');
      p.draftKey = JSON.stringify(d);
      await evaluateInWorker(proposalDocument(snapshot, p)); proposalDocument(latest.current, p);
      setProposal(p); setStatus('描いた形をプレビューしています');
    } catch (e) { setStatus(e.message); }
  }

  return {
    mesh, ghost, group, setGroup, mode, setMode, paint, setPaint, proposal, pending, status, meshStatus,
    adapterMode, setAdapterMode, selectedFeatureId, setSelectedFeatureId, submit, runCommands,
    requestId, draft, requestSketch, previewSketch, message: setStatus,
    updateDraft(value) { setDocument(current => {
      const cad = cadOf(current), before = cad.draft || emptyDraft();
      const next = typeof value === 'function' ? value(before) : value; validateDraft(next);
      return { ...current, cad: { ...cad, draft: next } };
    }); },
    groups: cadOf(document).selectionGroups,
    select(ref, brush = false) {
      setStatus('');
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
      if (!last) { setStatus('まだ戻せる変更がありません'); return; }
      if (geometryKey(latest.current) !== last.key) { setStatus('他のモデル編集があるため戻せません'); return; }
      undo.current.pop(); setDocument(current => ({ ...current, cad: { ...last.cad, draft: cadOf(current).draft } })); setProposal(null); setGhost(null); setStatus('ひとつ前の変更に戻しました');
    },
  };
}
