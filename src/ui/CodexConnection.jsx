import React from 'react';
export default function CodexConnection({ workspace: w }) {
  if (w.adapterMode !== 'codex') return <p className="command-note">Codex接続は個人用Sitesで利用できます。この画面でも形のプレビューと数値編集は使えます。</p>;
  return <div className="codex-connection">
    <strong>Codexとつなぐ</strong>
    <p>このサイトのプラグインをCodexに接続し、依頼を送った後に「CADの最新依頼を確認してモデルを提案して」と伝えてください。</p>
    {w.requestId && w.pending ? <p>依頼を送信済み。Codexの提案を待っています。待っている間も描画・編集できます。</p> : null}
    <button type="button" onClick={async () => { try { await navigator.clipboard.writeText(`個人用AI CADサイトの${w.requestId ? `依頼 ${w.requestId}` : '最新依頼'}を読み、スケッチ・寸法・コメントを確認して、許可されたCAD命令でモデルを提案してください。曖昧な点は質問してください。`); w.message('Codexへの依頼文をコピーしました'); } catch { w.message('Codexに「CADの最新依頼を確認してモデルを提案して」と伝えてください'); } }}>Codexへの依頼文をコピー</button>
    <a href="https://chatgpt.com/codex" target="_blank" rel="noreferrer">Codexを開く</a>
  </div>;
}
