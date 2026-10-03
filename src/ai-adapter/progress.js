export const elapsedLabel = ms => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}秒` : seconds < 3600 ? `${Math.floor(seconds / 60)}分${seconds % 60}秒` : `${Math.floor(seconds / 3600)}時間${Math.floor(seconds % 3600 / 60)}分`;
};
export function describeProgress(p, now = Date.now()) {
  if (!p) return null;
  const w = p.webhook || {}, phase = p.phase;
  const labels = { sending: '依頼を送信中', restoring: '保存済みの依頼を確認中', waiting: '受付済み・dotの応答待ち', clarification: '確認質問が届いています', received: '提案を受信・形状を準備中', geometry: '提案の形状を計算中', ready: '提案の形状を準備できました', applying: '変更を適用中', applied: '適用が完了しました', 'already-applied': 'この文書では適用済み', retrying: '通信を再確認中', paused: '応答の確認を停止しました', error: '状態を確認してください', cancelling: '取消を確認中', cancelled: '依頼を取り消しました', stopped: '待機を中止しました' };
  let detail = '';
  if (phase === 'waiting') detail = w.delivered ? '通知先が受信しました。dotの実行開始は未確認です。' : w.failed ? '通知に失敗しました。保存済みの依頼をdotに伝えてください。' : w.stopped ? '通知は停止しています。同じ依頼の状態を確認してください。' : w.notificationError || w.unavailable ? '依頼は保存済みです。通知状況を確認できません。' : w.connected === false ? '自動通知が未接続です。保存済みの依頼をdotに伝えてください。' : '依頼は保存済みです。通知の受付を確認しています。';
  if (phase === 'clarification') detail = '質問への補足をdotに伝えてください。この依頼の応答確認は続いています。';
  if (phase === 'geometry') detail = 'この端末で計算しています。現在のモデルは変更していません。';
  if (phase === 'already-applied') detail = '文書に保存された適用履歴を確認しました。再適用はしません。';
  if (phase === 'ready') detail = 'まだ適用していません。形と前提を確認してください。';
  if (phase === 'retrying') detail = `通信の再試行 ${p.retryAttempt || 1}/3。依頼は再送しません。`;
  if (['error', 'paused', 'stopped'].includes(phase)) detail = p.requestId ? '「同じ依頼を確認」で再開できます。新しい依頼は送りません。' : '送信結果は未確認です。保存済みの依頼を確認してください。';
  if (phase === 'error' && p.error) detail = p.error.slice(0, 160) + ' ' + detail;
  const started = Date.parse(p.createdAt) || p.startedAt, end = p.finishedAt || now;
  const secondsWaiting = Math.max(0, (now - (Date.parse(p.createdAt) || p.startedAt || now)) / 1000);
  const busy = ['sending','restoring','waiting','received','geometry','applying','retrying','cancelling'].includes(phase) && !(phase === 'waiting' && (w.failed || w.stopped || w.notificationError || w.unavailable || w.connected === false));
  const step = ['sending','restoring'].includes(phase) ? 0 : ['waiting','clarification','retrying'].includes(phase) ? 1 : ['received','geometry'].includes(phase) ? 2 : ['ready','applying','applied','already-applied'].includes(phase) ? 3 : null;
  return { label: labels[phase] || '状態を確認中', detail, busy, step, elapsed: started ? elapsedLabel(end - started) : null,
    longWait: phase === 'waiting' && secondsWaiting >= 60 ? '応答に時間がかかっています。実行中かは確認できず、完了時刻は未定です。' : '',
    retry: !!p.requestId && ['error','paused','stopped'].includes(phase) };
}
