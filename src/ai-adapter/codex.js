// Site-hosted MCP exchange. Reading or leaving a request never cancels it.
// Only the explicit cancel action changes its saved state.
const requestIdPattern = /^[a-f0-9-]{36}$/;
const transientStatuses = new Set([408, 429, 500, 502, 503]);
const aborted = signal => { if (signal?.aborted) throw new DOMException('Aborted', 'AbortError'); };
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
export function createCodexAdapter({ fetcher = globalThis.fetch, interval = 1800, retryDelay = 200, onQueued = () => {}, onWebhook = () => {}, onClarification = () => {} } = {}) {
  const json = async (url, options = {}) => {
    const isRead = !options.method || options.method === 'GET';
    for (let attempt = 0; ; attempt++) {
      aborted(options.signal);
      let response;
      try { response = await fetcher(url, { credentials: 'same-origin', ...options }); }
      catch (error) {
        if (error.name === 'AbortError' || options.signal?.aborted) { aborted(options.signal); throw error; }
        if (isRead && attempt < 3) { await pause(retryDelay * 2 ** attempt, options.signal); continue; }
        throw new Error('Codexとの通信が途切れました。保存済みの依頼から再確認できます');
      }
      aborted(options.signal);
      if (!response.ok) {
        let error; try { error = (await response.json()).error; } catch { /* non-JSON gateway */ }
        if (isRead && transientStatuses.has(response.status) && attempt < 3) { await pause(retryDelay * 2 ** attempt, options.signal); continue; }
        throw new Error(error || (response.status === 401 ? '個人用サイトにログインし直してください' : 'Codexとの接続を利用できません。スケッチは保存されています'));
      }
      try { return await response.json(); }
      catch (error) {
        if (error.name === 'AbortError' || options.signal?.aborted) { aborted(options.signal); throw error; }
        // Stream/network failures can occur after the response headers arrived.
        // Invalid JSON is a server-data error, not a reason to repeat a request.
        if (isRead && error instanceof TypeError && attempt < 3) { await pause(retryDelay * 2 ** attempt, options.signal); continue; }
        throw error;
      }
    }
  };
  async function waitForResponse(requestId, { signal, initial } = {}) {
    const deadline = Date.now() + 15 * 60 * 1000;
    let result = initial, lastQuestion = '';
    while (Date.now() < deadline) {
      aborted(signal);
      result ??= await json('/api/cad/requests/' + requestId, { signal });
      if (result.webhook) onWebhook(result.webhook);
      if (result.cancelled) throw new Error('この依頼は取り消し済みです');
      if (result.response?.clarification && !result.response.commands) {
        if (lastQuestion !== result.response.clarification) {
          lastQuestion = result.response.clarification;
          onClarification(lastQuestion, result.responseRevision);
        }
      } else if (result.response) return { ...result.response, requestId };
      result = null;
      await pause(interval, signal);
    }
    throw new Error('Codexの応答待ちを終了しました。このページを再読み込みすると同じ依頼を確認できます。');
  }
  return {
    async connection({ signal } = {}) { return json('/api/cad/connection', { signal }); },
    async recent({ signal } = {}) { return (await json('/api/cad/requests', { signal })).requests; },
    async cancel(requestId) { return json('/api/cad/requests/' + validId(requestId) + '/cancel', { method: 'POST' }); },
    async propose(request, { signal } = {}) {
      const requestId = crypto.randomUUID();
      const queued = await json('/api/cad/requests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId, request }), signal });
      onQueued(requestId, queued.webhook);
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
