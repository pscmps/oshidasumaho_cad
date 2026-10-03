import React, { useEffect, useState } from 'react';
import { describeProgress, elapsedLabel } from '../ai-adapter/progress.js';

export default function RequestProgress({ workspace: w }) {
  const [now, setNow] = useState(Date.now());
  const p = w.progress;
  useEffect(() => {
    if (!p || p.finishedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [!!p, p?.finishedAt]);
  const view = describeProgress(p, now);
  if (!view) return null;
  return <section className={`request-progress ${view.busy ? 'is-waiting' : ''}`} aria-label="依頼の進捗">
    <div className="request-progress-heading"><strong role="status">{view.label}</strong>{view.elapsed ? <span>経過 {view.elapsed}</span> : null}</div>
    {view.busy ? <progress aria-label={view.label} /> : null}
    {p.requestId ? <ol aria-label="依頼の段階">{['受付','応答','形状','確認'].map((label, i) => <li key={label} className={view.step === i ? 'current' : view.step > i ? 'done' : ''} aria-current={view.step === i ? 'step' : undefined}>{label}</li>)}</ol> : null}
    <p>{view.detail}</p>
    {view.longWait ? <p>{view.longWait}</p> : null}
    {p.checkedAt ? <small>最終確認 {new Date(p.checkedAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}{p.phase === 'waiting' && now - p.checkedAt > 15000 ? ' · 状態の更新が止まっています' : ''}</small> : null}
    {p.geometryMs !== undefined ? <small>今回の形状準備 {p.geometryMs < 100 ? '0.1秒未満' : p.geometryMs < 1000 ? `${(p.geometryMs / 1000).toFixed(1)}秒` : elapsedLabel(p.geometryMs)}</small> : null}
    <div className="request-progress-actions">{view.retry ? <button type="button" onClick={() => w.resumeRequest(p.requestId)}>同じ依頼を確認</button> : null}{w.pending ? <button type="button" onClick={w.cancel}>依頼を取り消す</button> : null}</div>
  </section>;
}
