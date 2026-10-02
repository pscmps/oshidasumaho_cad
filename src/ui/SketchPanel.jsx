import React, { useEffect, useRef } from 'react';
import { VIEW_LABELS, dimensionHints } from '../cad-core/rough-sketch.js';
import CodexConnection from './CodexConnection.jsx';

export default function SketchPanel({ workspace: w, selectedComment, onComment }) {
  const draft = w.draft, commentInput = useRef();
  const comment = selectedComment && draft.views[selectedComment.view].comments.find(c => c.id === selectedComment.id);
  useEffect(() => { if (comment) { commentInput.current?.closest('.control-panel')?.scrollTo({ top: 0 }); commentInput.current?.focus({ preventScroll: true }); } }, [selectedComment?.id]);
  const note = (text, target) => w.updateDraft(d => ({ ...d, dimensions: { ...d.dimensions, ...dimensionHints(text) },
    ...(target ? { views: { ...d.views, [target.view]: { ...d.views[target.view], comments: d.views[target.view].comments.map(c => c.id === target.id ? { ...c, text } : c) } } } : { notes: text }) }));
  return <section className="command-panel sketch-panel" aria-label="スケッチからモデル化">
    {comment ? <div className="sketch-comment-editor"><label>{VIEW_LABELS[selectedComment.view]}のコメント<textarea ref={commentInput} aria-label="選んだ場所のコメント" value={comment.text} onChange={e => note(e.target.value, selectedComment)} placeholder="例：ここに直径8mmの穴 / この辺は高さ10mm" rows="2" /></label><button type="button" onClick={() => { w.updateDraft(d => ({ ...d, views: { ...d.views, [selectedComment.view]: { ...d.views[selectedComment.view], comments: d.views[selectedComment.view].comments.filter(c => c.id !== selectedComment.id) } } })); onComment(null); }}>コメントを削除</button></div> : null}
    <div className="sketch-primary">
      <strong>どんな部品にしますか？</strong>
      <textarea aria-label="部品の説明" value={draft.notes} onChange={e => note(e.target.value)} placeholder="例：板の中央に穴。厚さ3ミリ、角は少し丸く" rows="2" />
      <p className="command-note">文章に書いた寸法・条件を優先します。下の寸法欄とスケッチは、文章で指定していない部分を補います。確認質問への補足はdotに伝えられます。</p>
      <div className="draft-dimensions">{[['width', '幅'], ['depth', '奥行き'], ['height', '高さ']].map(([k, label]) => <label key={k}>{label} (mm)<input type="number" aria-label={`${label} (mm)`} key={`${k}-${draft.dimensions[k]}`} defaultValue={draft.dimensions[k]} min="0.1" max="10000" step="0.1" onBlur={e => { const n = +e.target.value; if (n > 0 && n <= 10000) w.updateDraft(d => ({ ...d, dimensions: { ...d.dimensions, [k]: n } })); else e.target.value = draft.dimensions[k]; }} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} /></label>)}</div>
      <button className="prompt-submit" type="button" onClick={() => { window.document.activeElement?.blur(); void w.requestSketch(); }}>{w.pending ? '新しい依頼をCodexへ送る' : 'Codexでモデル化'}</button>
      <button type="button" onClick={() => { window.document.activeElement?.blur(); void w.previewSketch(); }}>描いた形だけプレビュー</button>
    </div>
    {Object.entries(draft.views).map(([view, data]) => data.comments.length ? <div className="draft-comments" key={view}>{data.comments.map((c, i) => <button type="button" key={c.id} onClick={() => onComment({ view, id: c.id })}>{VIEW_LABELS[view]} {i + 1}：{c.text || 'コメントを入力'}</button>)}</div> : null)}
    {w.status ? <output className="command-status" aria-live="polite">{w.status}</output> : null}
    {w.pending ? <button type="button" onClick={w.cancel}>依頼を取り消す</button> : null}
    <CodexConnection workspace={w} />
    <p className="command-note">描いた形だけのプレビューは寸法欄を使い、外形と穴を各方向へ伸ばして重ねます。Codexは文章を優先し、補った前提を説明して未適用の提案を返します。</p>
  </section>;
}
