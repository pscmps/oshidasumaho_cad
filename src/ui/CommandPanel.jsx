import React, { useEffect, useRef, useState } from 'react';
import { featureTree } from '../cad-core/document.js';
import { GROUP_LABELS } from './NativeViewer.jsx';
import CodexConnection from './CodexConnection.jsx';

const EDIT_LABELS = { projection: '元の3面図の部品', extrude: '板・柱', sketchSolid: 'スケッチから作った部品', faceExtrude: '面を伸ばす / 削る', fillet: '角を丸める', chamfer: '面取り', transform: '移動・回転' };
const labelFor = (f, i) => `${f.type === 'extrude' ? `${f.profile.type === 'circle' ? '円柱' : '四角い板'} ${i + 1}` : EDIT_LABELS[f.type]}${f.radius !== undefined ? ` · 半径${f.radius}mm` : f.distance !== undefined ? ` · ${f.type === 'extrude' ? '厚さ' : ''}${f.distance}mm` : ''}`;

export default function CommandPanel({ document, workspace: w }) {
  const [text, setText] = useState(''), [listening, setListening] = useState(false), [voiceStatus, setVoiceStatus] = useState('');
  const recognition = useRef(), input = useRef();
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  useEffect(() => () => recognition.current?.abort(), []);
  const voice = () => {
    if (recognition.current) { recognition.current.stop(); return; }
    const r = new SpeechRecognition(); r.lang = 'ja-JP'; r.interimResults = true; r.continuous = false;
    recognition.current = r;
    r.onresult = e => { setText(Array.from(e.results).map(result => result[0].transcript).join('')); };
    r.onerror = () => setVoiceStatus('音声を認識できませんでした。もう一度試すか、欄に入力してください。');
    r.onend = () => { recognition.current = null; setListening(false); };
    try { r.start(); setListening(true); setVoiceStatus('話した内容を確認して「変更する」を押してください'); }
    catch { recognition.current = null; setListening(false); setVoiceStatus('このブラウザでは音声入力を開始できませんでした'); }
  };
  const tree = featureTree(document), feature = tree.find(f => f.id === w.selectedFeatureId);
  const color = GROUP_LABELS[w.group], selected = w.groups[w.group], type = selected[0]?.entityType || w.mode;
  const examples = type === 'body' ? [
    ['厚さを変える', `${color}の厚さを3ミリにして`], ['移動する', `${color}をX方向に5ミリ移動して`], ['回転する', `${color}をZ軸まわりに90度回して`], ['削除する', `${color}を削除`],
  ] : type === 'edge' ? [
    ['角を丸める', `${color}を半径2ミリで丸めて`], ['面取りする', `${color}を1ミリ面取りして`],
  ] : [
    ['削る', `${color}を3ミリ削って`], ['伸ばす', `${color}を5ミリ伸ばして`], ['角を丸める', `${color}の角を半径2ミリで丸めて`], ['面取りする', `${color}を1ミリ面取りして`],
  ];
  const fillExample = value => { setText(value); input.current?.focus({ preventScroll: true }); };
  const send = e => { e.preventDefault(); input.current?.blur(); if (text.trim()) void w.submit(text); };
  const addPart = () => {
    let x = -Infinity;
    for (const b of w.mesh?.bodies || []) for (const f of b.faces) for (let i = 0; i < f.vertices.length; i += 3) x = Math.max(x, f.vertices[i]);
    void w.runCommands([{ operation: 'addExtrude', profile: { type: 'rectangle', width: 40, height: 30 }, distance: 10, origin: [Number.isFinite(x) ? x + 30 : 0, 0, 0] }]);
  };
  return <section className="command-panel" aria-label="AIへの変更指示">
    <form className="command-form" onSubmit={send}>
      <div className="prompt-heading"><label htmlFor="cad-prompt">どう変えますか？</label><button type="button" className="undo-button" onClick={w.undo}>元に戻す</button></div>
      <div className="prompt-row">
        <input ref={input} id="cad-prompt" value={text} onChange={e => setText(e.target.value)} placeholder="例：赤いところを3ミリ削って" autoComplete="off" enterKeyHint="send" />
        {SpeechRecognition ? <button type="button" className="voice-button" aria-label={listening ? '音声入力を停止' : '音声で指示する'} aria-pressed={listening} onClick={voice}>{listening ? '停止' : '音声'}</button> : null}
      </div>
      <button type="submit" className="prompt-submit" disabled={!text.trim()}>{w.pending ? '別の指示を送る' : '変更する'}</button>
    </form>
    {voiceStatus ? <p className="command-note">{voiceStatus}</p> : null}
    {w.pending || w.status ? <div className="command-feedback"><output className="command-status" aria-live="polite">{w.status || '指示を確認中。モデルは引き続き操作できます。'}</output>{w.pending ? <button type="button" onClick={w.cancel}>取消</button> : null}</div> : null}
    {w.proposal ? <div className="command-proposal">
      <strong>この変更でよいですか？</strong><p>{w.proposal.explanation || '色のついたプレビューが変更後の形です。'}</p>
      {w.proposalIssue ? <p role="status">{w.proposalIssue} 保存された提案は確認できます。現在のスケッチへの適用はできません。</p> : null}
      <div className="command-actions"><button type="button" className="prompt-submit" disabled={!!w.proposalIssue || w.applying} onClick={w.applyProposal}>{w.applying ? '適用中…' : '適用'}</button><button type="button" onClick={w.cancel}>キャンセル</button></div>
    </div> : null}
    <div className="prompt-examples" aria-label="指示の例">
      <p className="command-note">{selected.length ? '例を選んで、数字を変えられます' : '上のモデルを選んでから、変更を伝えてください'}</p>
      <div className="command-actions">{examples.map(([label, value]) => <button key={label} type="button" onClick={() => fillExample(value)}>{label}</button>)}</div>
    </div>
    <p className="ai-availability">{w.adapterMode === 'codex' ? '数値の指示はすぐ反映。曖昧な意図はCodexへの依頼として送ります。' : w.adapterMode === 'connected' ? '曖昧な指示は接続したAIに相談できます。' : w.adapterMode === 'mock' ? 'AIの応答は動作確認用サンプルです。' : '数値の指示はすぐ反映。曖昧な指示にはAI接続が必要です。'}</p>
    {w.adapterMode === 'codex' ? <CodexConnection workspace={w} /> : null}
    <details className="feature-tree">
      <summary>寸法・編集履歴（{tree.length}）</summary>
      <button type="button" onClick={addPart}>＋ 四角い板を追加</button>
      <div className="feature-list">{tree.map((f, i) => <button type="button" key={f.id} aria-pressed={w.selectedFeatureId === f.id} className={w.selectedFeatureId === f.id ? 'active-toggle' : ''}
        onClick={() => w.setSelectedFeatureId(f.id)}>{labelFor(f, i)}</button>)}</div>
      {feature && feature.type !== 'projection' ? <div className="feature-parameters">
        {feature.dimensions ? Object.entries(feature.dimensions).map(([k, value]) => <label key={`${feature.id}-${k}`}>{({width:'幅',depth:'奥行き',height:'高さ'})[k]} (mm)<input type="number" key={`${feature.id}-${k}-${value}`} defaultValue={value} step="0.1" onBlur={e => { const n = +e.target.value; if (Number.isFinite(n) && n !== value) w.runCommands([{ operation: 'modifyFeature', featureId: feature.id, changes: { dimensions: { ...feature.dimensions, [k]: n } } }]); }} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} /></label>) : null}
        {['radius', 'distance'].filter(k => feature[k] !== undefined).map(k => <label key={`${feature.id}-${k}`}>{k === 'radius' ? '丸みの半径 (mm)' : feature.type === 'extrude' ? '板・柱の厚さ (mm)' : '変更量 (mm)'}
          <input type="number" key={`${feature.id}-${k}-${feature[k]}`} defaultValue={feature[k]} step="0.1" onBlur={e => {
            if (!e.target.value.trim()) return;
            const value = Number(e.target.value); if (Number.isFinite(value) && value !== feature[k]) w.runCommands([{ operation: 'modifyFeature', featureId: feature.id, changes: { [k]: value } }]);
          }} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} /></label>)}
        <button type="button" onClick={() => w.runCommands([{ operation: 'removeFeature', featureId: feature.id }])}>この編集と、それに続く編集を削除</button>
      </div> : null}
    </details>
    <details className="ai-settings"><summary>AI接続・開発用設定</summary>
      <label>指示の解釈 <select aria-label="指示の解釈" value={w.adapterMode} onChange={e => w.setAdapterMode(e.target.value)}>
        <option value="offline">数値の指示を端末で処理</option><option value="mock">サンプル応答で試す（AI未接続）</option>
        {import.meta.env.VITE_SITE_CODEX === '1' ? <option value="codex">Codexにつなぐ</option> : null}
        {window.oshidaCadAIAdapter?.propose ? <option value="connected">接続したAIを使う</option> : null}
      </select></label>
      <details><summary>構造化データを確認</summary><pre>{JSON.stringify(w.groups, null, 2)}</pre></details>
    </details>
  </section>;
}
