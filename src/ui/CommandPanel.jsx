import React, { useEffect, useRef, useState } from 'react';
import { GROUPS } from '../cad-core/selectors.js';
import { featureTree } from '../cad-core/document.js';
import { GROUP_COLORS, GROUP_LABELS } from './NativeViewer.jsx';

export default function CommandPanel({ document, workspace: w }) {
  const [text, setText] = useState(''), [listening, setListening] = useState(false), [voiceStatus, setVoiceStatus] = useState('');
  const recognition = useRef();
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  useEffect(() => () => recognition.current?.abort(), []);
  const voice = () => {
    if (recognition.current) { recognition.current.stop(); return; }
    const r = new SpeechRecognition(); r.lang = 'ja-JP'; r.interimResults = true; r.continuous = false;
    recognition.current = r;
    r.onresult = e => { setText(Array.from(e.results).map(result => result[0].transcript).join('')); };
    r.onerror = e => setVoiceStatus(`音声入力: ${e.error}`);
    r.onend = () => { recognition.current = null; setListening(false); };
    try { r.start(); setListening(true); setVoiceStatus('認識した文章を確認して実行してください'); }
    catch (e) { recognition.current = null; setListening(false); setVoiceStatus(e.message); }
  };
  const tree = featureTree(document), feature = tree.find(f => f.id === w.selectedFeatureId);
  return <section className="command-panel" aria-label="AI-native CAD指示">
    <div className="selection-groups" role="group" aria-label="指示グループ">
      {GROUPS.map(g => <button type="button" key={g} className={w.group === g ? 'active-toggle' : ''} aria-pressed={w.group === g}
        style={{ borderColor: GROUP_COLORS[g] }} onClick={() => w.setGroup(g)}><span style={{ color: GROUP_COLORS[g] }}>●</span> {GROUP_LABELS[g]} ({w.groups[g].length})</button>)}
    </div>
    <div className="command-actions" role="group" aria-label="選択方法">
      {['face', 'edge', 'body'].map(m => <button key={m} type="button" aria-pressed={w.mode === m} className={w.mode === m ? 'active-toggle' : ''} onClick={() => w.setMode(m)}>{m === 'face' ? 'Face' : m === 'edge' ? 'Edge' : 'Body'}</button>)}
      <button type="button" aria-pressed={w.paint} className={w.paint ? 'active-toggle' : ''} onClick={() => w.setPaint(!w.paint)}>塗る</button>
      <button type="button" onClick={w.clearGroup}>選択解除</button>
    </div>
    <form className="command-form" onSubmit={e => { e.preventDefault(); if (text.trim()) void w.submit(text); }}>
      <label htmlFor="cad-prompt">対象を選んで、短く指示</label>
      <div className="prompt-row">
        <input id="cad-prompt" value={text} onChange={e => setText(e.target.value)} placeholder="赤を3ミリ削って / R3 / X5mm移動" autoComplete="off" />
        <button type="submit">実行</button>
        {SpeechRecognition ? <button type="button" aria-pressed={listening} onClick={voice}>{listening ? '停止' : '音声'}</button> : null}
      </div>
    </form>
    {voiceStatus || !SpeechRecognition ? <p className="command-note">{voiceStatus || '音声入力は対応ブラウザで利用できます。テキスト入力はいつでも使えます。'}</p> : null}
    <div className="command-actions">
      <label>意図の解釈 <select value={w.adapterMode} onChange={e => w.setAdapterMode(e.target.value)}>
        <option value="offline">ローカルのみ</option><option value="mock">モックAI（動作確認）</option>
        {window.oshidaCadAIAdapter?.propose ? <option value="connected">接続済みAI</option> : null}
      </select></label>
      <button type="button" onClick={w.undo}>元に戻す</button>
      {w.pending ? <button type="button" onClick={w.cancel}>問い合わせを取消</button> : null}
    </div>
    <output className="command-status" aria-live="polite">{w.pending ? '処理中・CADは操作できます。 ' : ''}{w.status}</output>
    {w.proposal ? <div className="command-proposal">
      <strong>変更の提案</strong><p>{w.proposal.explanation}</p>
      <pre>{JSON.stringify(w.proposal.commands, null, 2)}</pre>
      <div className="command-actions"><button type="button" onClick={w.applyProposal}>適用</button><button type="button" onClick={w.cancel}>キャンセル</button></div>
    </div> : null}
    <p className="command-note">Face: 平面の押出・削り / FaceのR・C: 境界Edge / 削除: Body。赤・緑・青に固定の操作意味はありません。</p>
    <details className="feature-tree" open>
      <summary>フィーチャー ({tree.length})</summary>
      <button type="button" onClick={() => w.runCommands([{ operation: 'addExtrude', profile: { type: 'rectangle', width: 40, height: 30 }, distance: 10, origin: [0, 0, 0] }])}>+ 四角柱 40×30×10</button>
      <div className="feature-list">{tree.map(f => <button type="button" key={f.id} aria-pressed={w.selectedFeatureId === f.id} className={w.selectedFeatureId === f.id ? 'active-toggle' : ''}
        onClick={() => w.setSelectedFeatureId(f.id)}>{f.id} · {f.type}{f.radius !== undefined ? ` · R${f.radius}` : f.distance !== undefined ? ` · ${f.distance}mm` : ''}</button>)}</div>
      {feature && feature.type !== 'projection' ? <div className="feature-parameters">
        {['radius', 'distance'].filter(k => feature[k] !== undefined).map(k => <label key={`${feature.id}-${k}`}>{k === 'radius' ? 'R (mm)' : '距離 (mm)'}
          <input type="number" key={`${feature.id}-${k}-${feature[k]}`} defaultValue={feature[k]} step="0.1" onBlur={e => {
            const value = Number(e.target.value); if (value !== feature[k]) w.runCommands([{ operation: 'modifyFeature', featureId: feature.id, changes: { [k]: value } }]);
          }} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} /></label>)}
        <button type="button" onClick={() => w.runCommands([{ operation: 'removeFeature', featureId: feature.id }])}>このフィーチャーと後続を削除</button>
      </div> : null}
    </details>
    <details><summary>選択データ / command例</summary>
      <pre>{JSON.stringify(w.groups, null, 2)}</pre>
      <p className="command-note">R3、C1、3mm、赤を5mm伸ばす、青をZ90度回転。モックは「少し丸く」「この辺を逃がして」。JSON commandも入力できます。</p>
    </details>
  </section>;
}
