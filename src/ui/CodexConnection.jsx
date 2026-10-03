import React, { useEffect, useState } from 'react';
import { createCodexAdapter } from '../ai-adapter/codex.js';
export default function CodexConnection({ workspace: w }) {
  const [connection, setConnection] = useState(null);
  useEffect(() => {
    if (w.adapterMode !== 'codex') return;
    const controller = new AbortController();
    const refresh = () => createCodexAdapter().connection({ signal: controller.signal }).then(setConnection).catch(() => { if (!controller.signal.aborted) setConnection({ unavailable: true }); });
    refresh(); window.addEventListener('focus', refresh);
    return () => { controller.abort(); window.removeEventListener('focus', refresh); };
  }, [w.adapterMode]);
  if (w.adapterMode !== 'codex') return <p className="command-note">Codex接続は個人用Sitesで利用できます。この画面でも形のプレビューと数値編集は使えます。</p>;
  const state = w.pending && w.webhook ? w.webhook : connection;
  return <div className="codex-connection">
    {w.recentRequests?.length ? <details open={!w.requestId} className="cad-request-recovery">
      <summary>保存済みの依頼・提案を開く</summary>
      <p>再送せずに、届いた提案を確認できます。</p>
      {w.recentRequests.map(r => <button type="button" key={r.requestId} disabled={w.pending && w.requestId === r.requestId} onClick={() => void w.resumeRequest(r.requestId)}>
        {r.state === 'answered' ? '回答を見る' : '応答を確認'} · {r.prompt.split('\n')[0].slice(0,100)}
      </button>)}
    </details> : w.recentError ? <p role="status">保存済み依頼を確認できません：{w.recentError}</p> : null}
    <strong>dotとの自動連携</strong>
    <p>{!state ? '接続を確認中…' : state.unavailable ? '接続状態を確認できません。サイトへのログインを確認してください。' : state.connected ? '接続済み。依頼を送るとdotへ通知します。提案はこの画面で確認してから適用できます。' : '未接続。このサイトのプラグインをdotに接続し、「CADの新しい依頼を受け取ったら、モデルを読んで提案を返して」と伝えてください。'}</p>
    {w.requestId && w.pending ? <p role="status">{state?.delivered ? '通知先が受信済み。dotの実行開始は未確認です。' : state?.failed ? '通知に失敗しました。依頼は保存されています。下の依頼文をdotへ送れます。' : state?.connected ? '依頼は保存済み。dotへ通知中です。' : '依頼は保存済み。自動通知は未接続です。'} 待っている間も描画・編集できます。</p> : null}
    <button type="button" onClick={async () => { try { await navigator.clipboard.writeText(`個人用AI CADサイトの${w.requestId ? `依頼 ${w.requestId}` : '最新依頼'}を読み、文章に明記した寸法・条件を優先し、未記載の部分だけ寸法欄とスケッチで補って、許可されたCAD命令で未適用のモデルを提案してください。合理的に補った前提は説明し、既定寸法欄との不一致だけでは確認で止めないでください。`); w.message('Codexへの依頼文をコピーしました'); } catch { w.message('Codexに「CADの最新依頼を確認してモデルを提案して」と伝えてください'); } }}>Codexへの依頼文をコピー</button>
    <a href="https://chatgpt.com/codex" target="_blank" rel="noreferrer">Codexを開く</a>
    <p>通信中断時の未送信通知は、この画面を開いている間に再確認します。</p>
  </div>;
}
