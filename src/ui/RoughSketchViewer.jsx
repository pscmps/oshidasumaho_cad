import React, { useRef, useState } from 'react';
import { SKETCH_VIEWS, VIEW_LABELS, VIEW_AXES, strokePoints } from '../cad-core/rough-sketch.js';

const COLORS = { outline: '#24629e', cut: '#d84d53', guide: '#7791a9' };
const pointAt = (e, svg) => { const b = svg.getBoundingClientRect(); return [Math.max(0, Math.min(1, (e.clientX - b.left) / b.width)), Math.max(0, Math.min(1, 1 - (e.clientY - b.top) / b.height))]; };
function Stroke({ stroke }) {
  const p = strokePoints(stroke).map(p => [p[0] * 100, (1 - p[1]) * 100]);
  return <polyline points={[...p, ...(stroke.tool === 'pen' ? [] : [p[0]])].map(p => p.join(',')).join(' ')} fill="none" stroke={COLORS[stroke.role]} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeDasharray={stroke.role === 'guide' ? '5 4' : undefined} strokeLinejoin="round" strokeLinecap="round" />;
}
export default function RoughSketchViewer({ draft, updateDraft, selectedComment, onComment }) {
  const [tool, setTool] = useState('pen'), [role, setRole] = useState('outline'), [full, setFull] = useState(null);
  const [live, setLive] = useState(null), drawing = useRef(), pointers = useRef(new Set());
  const mutateView = (view, fn) => updateDraft(d => ({ ...d, views: { ...d.views, [view]: fn(d.views[view]) } }));
  const down = (e, view) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    pointers.current.add(e.pointerId); e.currentTarget.setPointerCapture(e.pointerId);
    if (pointers.current.size !== 1) { drawing.current = null; setLive(null); return; }
    const point = pointAt(e, e.currentTarget);
    drawing.current = { view, pointer: e.pointerId, svg: e.currentTarget, stroke: { id: crypto.randomUUID(), tool, role, points: [point, point] } };
    if (tool !== 'comment') setLive(drawing.current);
  };
  const move = e => {
    const d = drawing.current; if (!d || d.pointer !== e.pointerId || pointers.current.size !== 1 || d.stroke.tool === 'comment') return;
    const p = pointAt(e, d.svg), points = d.stroke.points;
    if (d.stroke.tool === 'pen') {
      if (Math.hypot(...p.map((n, i) => n - points.at(-1)[i])) < 0.004 || points.length >= 600) return;
      d.stroke = { ...d.stroke, points: [...points, p] };
    } else d.stroke = { ...d.stroke, points: [points[0], p] };
    setLive({ ...d });
  };
  const up = e => {
    const d = drawing.current;
    if (d && d.pointer === e.pointerId && pointers.current.size === 1) {
      if (d.stroke.tool === 'comment') {
        const comment = { id: crypto.randomUUID(), position: pointAt(e, d.svg), text: '' };
        mutateView(d.view, v => ({ ...v, comments: [...v.comments, comment] })); onComment({ view: d.view, id: comment.id });
      } else if (d.stroke.points.some(p => Math.hypot(...p.map((n, i) => n - d.stroke.points[0][i])) > 0.01))
        mutateView(d.view, v => ({ ...v, strokes: [...v.strokes, d.stroke] }));
    }
    pointers.current.delete(e.pointerId); drawing.current = null; setLive(null);
  };
  const cancel = e => { pointers.current.delete(e.pointerId); drawing.current = null; setLive(null); };
  return <div className="rough-workspace">
    <div className="sketch-tools" role="group" aria-label="スケッチ道具">
      {[['pen', '自由線'], ['rect', '四角'], ['ellipse', '円'], ['comment', 'コメント']].map(([k, label]) => <button type="button" key={k} aria-pressed={tool === k} className={tool === k ? 'active-toggle' : ''} onClick={() => setTool(k)}>{label}</button>)}
      <select value={role} onChange={e => setRole(e.target.value)} aria-label="線の用途"><option value="outline">外形</option><option value="cut">穴・切抜き</option><option value="guide">補助線</option></select>
    </div>
    <div className={`rough-grid ${full ? 'rough-grid-full' : ''}`}>
      {SKETCH_VIEWS.filter(v => !full || full === v).map(view => <div key={view} className="rough-pane">
        <button type="button" className="rough-view-title" aria-label={`${VIEW_LABELS[view]}を${full ? '縮小' : '拡大'}`} onClick={() => setFull(full ? null : view)}>{VIEW_LABELS[view]} <span>{VIEW_AXES[view].map(k => `${draft.dimensions[k]}mm`).join(' × ')}</span></button>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label={`${VIEW_LABELS[view]}のスケッチ`} onPointerDown={e => down(e, view)} onPointerMove={move} onPointerUp={up} onPointerCancel={cancel}>
          <defs><pattern id={`rough-grid-${view}`} width="10" height="10" patternUnits="userSpaceOnUse"><path d="M 10 0 L 0 0 0 10" fill="none" stroke="#e5edf5" strokeWidth="0.4" /></pattern></defs>
          <rect width="100" height="100" fill={`url(#rough-grid-${view})`} />
          {draft.views[view].strokes.map(s => <Stroke key={s.id} stroke={s} />)}
          {live?.view === view ? <Stroke stroke={live.stroke} /> : null}
          {draft.views[view].comments.map((c, i) => <g key={c.id} onPointerDown={e => e.stopPropagation()} onClick={() => onComment({ view, id: c.id })} className="rough-marker">
            <circle cx={c.position[0] * 100} cy={(1 - c.position[1]) * 100} r="4" fill={selectedComment?.id === c.id ? '#efae36' : '#285e98'} />
            <text x={c.position[0] * 100} y={(1 - c.position[1]) * 100 + 1.6} textAnchor="middle" fill="white" fontSize="5">{i + 1}</text>
          </g>)}
        </svg>
        <button type="button" className="rough-undo" aria-label={`${VIEW_LABELS[view]}の最後の線を戻す`} onClick={() => mutateView(view, v => ({ ...v, strokes: v.strokes.slice(0, -1) }))}>線を戻す</button>
      </div>)}
      {!full ? <div className="rough-help"><strong>ざっくり描いて<br />Codexに伝える</strong><p>外形は青、穴は赤。<br />コメントは場所をタップ。</p><p>各面の名前を押すと<br />大きく描けます。</p></div> : null}
    </div>
  </div>;
}
