// Site-hosted MCP exchange: Codex reads a request and stages an allowed-command response.
// This does not invoke Codex on the user's behalf or require an API key.
export function createCodexAdapter({ fetcher = globalThis.fetch, interval = 1800, onQueued = () => {} } = {}) {
  const json = async (url, options) => {
    const response = await fetcher(url, { credentials: 'same-origin', ...options });
    if (!response.ok) {
      let error; try { error = (await response.json()).error; } catch { /* non-JSON gateway */ }
      throw new Error(error || (response.status === 401 ? '個人用サイトにログインし直してください' : 'Codexとの接続を利用できません。スケッチは保存されています'));
    }
    return response.json();
  };
  return { async propose(request, { signal } = {}) {
    const requestId = crypto.randomUUID();
    await json('/api/cad/requests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId, request }), signal });
    onQueued(requestId);
    const deadline = Date.now() + 15 * 60 * 1000;
    try {
      while (Date.now() < deadline) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const result = await json(`/api/cad/requests/${requestId}`, { signal });
        if (result.response) return result.response;
        if (result.cancelled) throw new Error('この依頼は取り消されています');
        await new Promise((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
          const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, interval);
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort();
        });
      }
      throw new Error('Codexの応答待ちを終了しました。新しい依頼を送れます。スケッチは保存されています');
    } finally {
      // Cancel only this queued request; this never modifies model geometry.
      if (signal?.aborted) void json(`/api/cad/requests/${requestId}/cancel`, { method: 'POST' }).catch(() => {});
    }
  } };
}
