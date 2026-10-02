// Site-hosted MCP exchange. Clarification keeps the same request waiting;
// explicit supplemented answers may advance it to an unapplied proposal.
export function createCodexAdapter({ fetcher = globalThis.fetch, interval = 1800, onQueued = () => {}, onWebhook = () => {}, onClarification = () => {} } = {}) {
  const json = async (url, options) => {
    const response = await fetcher(url, { credentials: 'same-origin', ...options });
    if (!response.ok) {
      let error; try { error = (await response.json()).error; } catch { /* non-JSON gateway */ }
      throw new Error(error || (response.status === 401 ? '個人用サイトにログインし直してください' : 'Codexとの接続を利用できません。スケッチは保存されています'));
    }
    return response.json();
  };
  async function waitForResponse(requestId, { signal, initial } = {}) {
    const deadline = Date.now() + 15 * 60 * 1000;
    let result = initial, lastQuestion = '';
    try {
      while (Date.now() < deadline) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        result ??= await json('/api/cad/requests/' + requestId, { signal });
        if (result.webhook) onWebhook(result.webhook);
        if (result.cancelled) throw new Error('この依頼は取り消し済みです');
        if (result.response?.clarification && !result.response.commands) {
          if (lastQuestion !== result.response.clarification) {
            lastQuestion = result.response.clarification;
            onClarification(lastQuestion, result.responseRevision);
          }
        } else if (result.response) return result.response;
        result = null;
        await new Promise((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
          const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, interval);
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort();
        });
      }
      throw new Error('Codexの応答待ちを終了しました。このページを再読み込みすると同じ依頼を確認できます。');
    } finally {
      if (signal?.aborted) void json('/api/cad/requests/' + requestId + '/cancel', { method: 'POST' }).catch(() => {});
    }
  }
  return {
    async recent({ signal } = {}) { return (await json('/api/cad/requests', { signal })).requests; },
    async propose(request, { signal } = {}) {
      const requestId = crypto.randomUUID();
      const queued = await json('/api/cad/requests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId, request }), signal });
      onQueued(requestId, queued.webhook);
      return waitForResponse(requestId, { signal });
    },
    async resume(requestId, { signal } = {}) {
      if (!/^[a-f0-9-]{36}$/.test(requestId)) throw new Error('依頼番号が不正です');
      const initial = await json('/api/cad/requests/' + requestId + '?includeRequest=1', { signal });
      if (!initial.request) throw new Error('元の依頼を取得できませんでした');
      onQueued(requestId, initial.webhook);
      return { request: initial.request, response: await waitForResponse(requestId, { signal, initial }) };
    },
  };
}
