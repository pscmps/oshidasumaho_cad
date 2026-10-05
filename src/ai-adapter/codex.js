// Site-hosted MCP exchange. Reading or leaving a request never cancels it.
// Only the explicit cancel action changes its saved state.
const requestIdPattern = /^[a-f0-9-]{36}$/;
const transientStatuses = new Set([408, 429, 500, 502, 503]);
const aborted = signal => { if (signal?.aborted) throw new DOMException('Aborted', 'AbortError'); };
const canonical = value => JSON.stringify(value, function (key, item) {
  return item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item;
});
function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const abort = () => { clearTimeout(timer); cleanup(); reject(new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
function validId(id) { if (!requestIdPattern.test(id || '')) throw new Error('依頼番号が不正です'); return id; }
export function createCodexAdapter({ fetcher = globalThis.fetch, interval = 1800, retryDelay = 200, onQueued = () => {}, onWebhook = () => {}, onClarification = () => {}, onProgress = () => {}, timeoutMs = 15 * 60 * 1000, now = Date.now, sleep = pause } = {}) {
  const json = async (url, options = {}) => {
    const isRead = !options.method || options.method === 'GET';
    for (let attempt = 0; ; attempt++) {
      aborted(options.signal);
      let response;
      try { response = await fetcher(url, { credentials: 'same-origin', ...options }); }
      catch (error) {
        if (error.name === 'AbortError' || options.signal?.aborted) { aborted(options.signal); throw error; }
        if (isRead && attempt < 3) { onProgress({ phase: 'retrying', retryAttempt: attempt + 1 }); await sleep(retryDelay * 2 ** attempt, options.signal); continue; }
        throw new Error('Codexとの通信が途切れました。保存済みの依頼から再確認できます');
      }
      aborted(options.signal);
      if (!response.ok) {
        let error; try { error = (await response.json()).error; } catch { /* non-JSON gateway */ }
        if (isRead && transientStatuses.has(response.status) && attempt < 3) { onProgress({ phase: 'retrying', retryAttempt: attempt + 1 }); await sleep(retryDelay * 2 ** attempt, options.signal); continue; }
        throw new Error(error || (response.status === 401 ? '個人用サイトにログインし直してください' : 'Codexとの接続を利用できません。スケッチは保存されています'));
      }
      try { return await response.json(); }
      catch (error) {
        if (error.name === 'AbortError' || options.signal?.aborted) { aborted(options.signal); throw error; }
        // Stream/network failures can occur after the response headers arrived.
        // Invalid JSON is a server-data error, not a reason to repeat a request.
        if (isRead && error instanceof TypeError && attempt < 3) { onProgress({ phase: 'retrying', retryAttempt: attempt + 1 }); await sleep(retryDelay * 2 ** attempt, options.signal); continue; }
        throw error;
      }
    }
  };
  async function waitForResponse(requestId, { signal, initial } = {}) {
    const deadline = now() + timeoutMs;
    let result = initial, lastQuestion = '';
    while (now() < deadline) {
      aborted(signal);
      result ??= await json('/api/cad/requests/' + requestId, { signal });
      if (result.webhook) onWebhook(result.webhook);
      onProgress({ phase: result.cancelled ? 'cancelled' : result.response?.commands ? 'received' : result.response?.clarification ? 'clarification' : 'waiting',
        requestId, createdAt: result.createdAt, responseAt: result.responseAt, webhook: result.webhook, checkedAt: now() });
      if (result.cancelled) throw Object.assign(new Error('この依頼は取り消し済みです'), { code: 'REQUEST_CANCELLED' });
      if (result.response?.clarification && !result.response.commands) {
        if (lastQuestion !== result.response.clarification) {
          lastQuestion = result.response.clarification;
          onClarification(lastQuestion, result.responseRevision);
        }
      } else if (result.response) return { ...result.response, requestId, responseRevision: result.responseRevision ?? 1 };
      result = null;
      await sleep(interval, signal);
    }
    onProgress({ phase: 'paused' });
    throw new Error('Codexの応答待ちを終了しました。このページを再読み込みすると同じ依頼を確認できます。');
  }
  return {
    async connection({ signal } = {}) { return json('/api/cad/connection', { signal }); },
    async recent({ signal } = {}) { return (await json('/api/cad/requests', { signal })).requests; },
    async cancel(requestId) { return json('/api/cad/requests/' + validId(requestId) + '/cancel', { method: 'POST' }); },
    async verifyProposal(proposal, { signal } = {}) {
      // Preview polling ends when commands arrive. Recheck the saved request
      // immediately before a manual commit; never infer validity from a cached ghost.
      const result = await json('/api/cad/requests/' + validId(proposal.requestId), { signal, cache: 'no-store' });
      aborted(signal);
      if (result.cancelled) throw Object.assign(new Error('この依頼は取り消し済みです'), { code: 'REQUEST_CANCELLED' });
      if (result.requestId !== proposal.requestId || !Number.isSafeInteger(proposal.responseRevision) || proposal.responseRevision < 1
        || result.responseRevision !== proposal.responseRevision || !result.response?.commands || result.response.clarification
        || canonical(result.response.commands) !== canonical(proposal.commands)) {
        throw new Error('提案の応答が変わっています。同じ依頼を確認してから適用してください。');
      }
    },
    async propose(request, { signal } = {}) {
      const requestId = crypto.randomUUID();
      onProgress({ phase: 'sending', startedAt: now() });
      const queued = await json('/api/cad/requests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId, request }), signal });
      onQueued(requestId, queued.webhook);
      onProgress({ phase: 'waiting', requestId, createdAt: queued.createdAt, webhook: queued.webhook, checkedAt: now() });
      return waitForResponse(requestId, { signal });
    },
    async resume(requestId, { signal } = {}) {
      validId(requestId);
      const initial = await json('/api/cad/requests/' + requestId + '?includeRequest=1', { signal });
      if (!initial.request) throw new Error('元の依頼を取得できませんでした');
      onQueued(requestId, initial.webhook);
      return { request: initial.request, response: await waitForResponse(requestId, { signal, initial }) };
    },
  };
}
