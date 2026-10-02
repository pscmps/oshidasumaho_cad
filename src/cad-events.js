// MCP Events: only explicit CAD submissions emit events. Model proposals do not.
// Subscription secrets and callback URLs stay in server-only R2 objects.
export const EVENT_NAME = 'cad.request.created';
export const EVENT = {
  name: EVENT_NAME,
  description: 'An authenticated user explicitly submitted a new CAD sketch or edit request. Read requestId with read_cad_request, then return a proposal with propose_cad_commands. Proposals are never automatically applied. No replay of submissions made before subscribing.',
  delivery: ['webhook'],
  inputSchema: { type: 'object', properties: { task: { type: 'string', enum: ['sketch', 'edit'], description: 'Optional request kind. Omit for both sketch and edit submissions.' } }, additionalProperties: false },
  payloadSchema: { type: 'object', properties: { requestId: { type: 'string' }, task: { type: 'string', enum: ['sketch', 'edit'] }, url: { type: 'string' } }, required: ['requestId', 'task', 'url'], additionalProperties: false },
};
const enc = new TextEncoder();
const MAX_TTL = 7 * 86400000, DEFAULT_TTL = 86400000;
const VERIFY_TTL = 300000, ROTATE_TTL = 60000, MAX_SUBSCRIPTIONS = 10;
const MAX_ATTEMPTS = 3, ATTEMPT_TIMEOUT = 5000;
const object = x => x && typeof x === 'object' && !Array.isArray(x);
export const canonical = value => JSON.stringify(object(value) ? Object.fromEntries(Object.keys(value).sort().map(k => [k, JSON.parse(canonical(value[k]))])) : Array.isArray(value) ? value.map(x => JSON.parse(canonical(x))) : value);
export class EventError extends Error {
  constructor(code, message, data) { super(message); this.code = code; this.data = data; }
}
const invalid = () => { throw new EventError(-32602, 'InvalidParams'); };
function exact(value, keys) { if (!object(value) || Object.keys(value).some(k => !keys.includes(k))) invalid(); }
export async function digest(value) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(value)))].map(x => x.toString(16).padStart(2, '0')).join(''); }
export function signingKey(secret) {
  if (typeof secret !== 'string' || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) invalid();
  const base = secret.slice(6); let raw;
  try { raw = atob(base); } catch { invalid(); }
  if (raw.length < 24 || raw.length > 64 || btoa(raw).replace(/=+$/, '') !== base.replace(/=+$/, '')) invalid();
  return Uint8Array.from(raw, x => x.charCodeAt(0));
}
export function callbackUrl(value) {
  let url; try { url = new URL(value); } catch { invalid(); }
  if (typeof value !== 'string' || value.length > 2048 || url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')) invalid();
  // IP literals and local hostnames are rejected before any network operation.
  if (!url.hostname.includes('.') || /[\[\]:]/.test(url.hostname) || /^[\d.]+$/.test(url.hostname) || /\.(?:localhost|local|internal|lan|test|invalid)$/.test(url.hostname) || url.hostname.endsWith('.')) invalid();
  return url.href;
}
function identity(params, subscribe) {
  exact(params, subscribe ? ['name', 'arguments', 'delivery', 'cursor', 'ttlMs', 'maxAgeMs', '_meta'] : ['name', 'arguments', 'delivery', '_meta']);
  if (params.name !== EVENT_NAME) throw new EventError(-32011, 'NotFound', { kind: 'event' });
  const args = params.arguments ?? {};
  exact(args, ['task']); if (args.task !== undefined && !['sketch', 'edit'].includes(args.task)) invalid();
  exact(params.delivery, subscribe ? ['mode', 'url', 'secret'] : ['mode', 'url']);
  if (params.delivery.mode !== 'webhook') throw new EventError(-32014, 'Unsupported', { feature: 'deliveryMode' });
  if (subscribe) {
    signingKey(params.delivery.secret);
    if (params.cursor !== undefined && params.cursor !== null && typeof params.cursor !== 'string') invalid();
    if (params.ttlMs !== undefined && params.ttlMs !== null && (!Number.isSafeInteger(params.ttlMs) || params.ttlMs <= 0)) invalid();
    if (params.maxAgeMs !== undefined && (!Number.isSafeInteger(params.maxAgeMs) || params.maxAgeMs < 0)) invalid();
  }
  return { name: EVENT_NAME, arguments: args, url: callbackUrl(params.delivery.url) };
}
export async function signature(secret, id, timestamp, body) {
  const key = await crypto.subtle.importKey('raw', signingKey(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const raw = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${id}.${timestamp}.${body}`)));
  return `v1,${btoa(String.fromCharCode(...raw))}`;
}
async function sameChallenge(a, b) {
  if (typeof a !== 'string' || a.length > 200) return false;
  const [ha, hb] = await Promise.all([digest(a), digest(b)]); let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}
async function readJsonBounded(response, limit = 4096) {
  if (!response.body) return null;
  const reader = response.body.getReader(); let total = 0, parts = [];
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; total += value.length; if (total > limit) { await reader.cancel(); return null; } parts.push(value); }
    const bytes = new Uint8Array(total); let p = 0; for (const part of parts) { bytes.set(part, p); p += part.length; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch { return null; } finally { reader.releaseLock(); }
}

// The injected transport is also used by deterministic protocol tests. Production
// installs an egress implementation that enforces address safety on every call.
export function createEvents(bucket, owner, { webhookFetch, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  if (!bucket) throw new EventError(-32603, 'StorageUnavailable');
  const root = `cad-events/${owner}/`, registryKey = `${root}subscriptions.json`;
  const get = async key => { const item = await bucket.get(key); return item ? { value: await item.json(), etag: item.etag } : null; };
  const put = (key, value, etag) => bucket.put(key, JSON.stringify(value), { onlyIf: etag ? { etagMatches: etag } : { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json' } });
  async function list(prefix, max = 100) {
    const result = []; let cursor;
    do { const page = await bucket.list({ prefix, limit: Math.min(max - result.length, 1000), ...(cursor ? { cursor } : {}) }); result.push(...page.objects); cursor = page.truncated ? page.cursor : null; } while (cursor && result.length < max);
    return result;
  }
  const active = s => s?.owner === owner && s.active && s.expiresAt > now();
  async function subscriptions() { const registry = await get(registryKey); return registry?.value.entries ?? []; }
  async function subscription(id) { return (await subscriptions()).find(s => s.id === id); }
  async function updateSubscriptions(change) {
    for (let n = 0; n < 8; n++) {
      const registry = await get(registryKey), entries = (registry?.value.entries ?? []).filter(active);
      const next = change(entries);
      if (await put(registryKey, { owner, entries: next }, registry?.etag)) return;
    }
    throw new EventError(-32603, 'ConcurrentSubscriptionUpdate');
  }
  async function signedPost(s, body, id) {
    if (!webhookFetch) throw new EventError(-32015, 'CallbackEndpointError', { reason: 'connection_refused' });
    if (enc.encode(body).length > 262144) return { ok: false, status: 413 };
    const timestamp = String(Math.floor(now() / 1000));
    const secrets = [s.secret, ...(s.previousSecret && s.rotateUntil > now() ? [s.previousSecret] : [])];
    const signatures = await Promise.all(secrets.map(secret => signature(secret, id, timestamp, body)));
    return webhookFetch(s.url, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(ATTEMPT_TIMEOUT), headers: { 'Content-Type': 'application/json', 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': signatures.join(' '), 'X-MCP-Subscription-Id': s.id }, body });
  }
  async function verify(s) {
    const cacheKey = `${root}verified/${await digest(s.url)}.json`, cache = await get(cacheKey), secretHash = await digest(s.secret);
    if (cache?.value.until > now() && cache.value.secretHash === secretHash) { console.info(JSON.stringify({ event: 'cad.callback.verification', outcome: 'cached' })); return; }
    const challenge = crypto.randomUUID() + crypto.randomUUID(), id = `msg_verification_${crypto.randomUUID()}`;
    let response;
    try { response = await signedPost(s, JSON.stringify({ type: 'verification', challenge }), id); }
    catch (e) { const reason = e.name === 'TimeoutError' ? 'timeout' : 'connection_refused'; const names = ['TypeError', 'Error', 'TimeoutError', 'AbortError', 'NetworkError']; console.warn(JSON.stringify({ event: 'cad.callback.verification', outcome: 'rejected', reason, exceptionType: names.includes(e.name) ? e.name : 'other', eventErrorCode: e instanceof EventError ? e.code : null })); throw new EventError(-32015, 'CallbackEndpointError', { reason }); }
    console.info(JSON.stringify({ event: 'cad.callback.verification', outcome: 'received', httpStatus: response.status }));
    if (!response.ok) { await response.body?.cancel(); throw new EventError(-32015, 'CallbackEndpointError', { reason: response.status >= 500 ? 'http_5xx' : 'http_4xx' }); }
    const result = await readJsonBounded(response);
    if (!(await sameChallenge(result?.challenge, challenge))) { console.warn(JSON.stringify({ event: 'cad.callback.verification', outcome: 'rejected', reason: 'challenge_failed' })); throw new EventError(-32015, 'CallbackEndpointError', { reason: 'challenge_failed' }); }
    await put(cacheKey, { until: now() + VERIFY_TTL, secretHash }, cache?.etag);
    console.info(JSON.stringify({ event: 'cad.callback.verification', outcome: 'complete' }));
  }
  async function subscribe(params) {
    const v = identity(params, true), id = `sub_${await digest(canonical({ owner, ...v }))}`;
    const duration = Math.min(MAX_TTL, params.ttlMs ?? DEFAULT_TTL);
    await verify({ id, ...v, secret: params.delivery.secret });
    let state;
    await updateSubscriptions(entries => {
      const prior = entries.find(s => s.id === id);
      if (!prior && entries.length >= MAX_SUBSCRIPTIONS) throw new EventError(-32013, 'ResourceExhausted', { limit: 'subscriptions', max: MAX_SUBSCRIPTIONS });
      state = { id, owner, ...v, active: true, secret: params.delivery.secret, expiresAt: now() + duration, createdAt: prior?.createdAt ?? now(), generation: prior?.generation ?? crypto.randomUUID() };
      if (prior && prior.secret !== state.secret) { state.previousSecret = prior.secret; state.rotateUntil = now() + ROTATE_TTL; }
      else if (prior?.rotateUntil > now()) { state.previousSecret = prior.previousSecret; state.rotateUntil = prior.rotateUntil; }
      return [...entries.filter(s => s.id !== id), state];
    });
    return { id, refreshBefore: new Date(state.expiresAt).toISOString(), cursor: null, truncated: false };
  }
  async function unsubscribe(params) {
    const v = identity(params, false), id = `sub_${await digest(canonical({ owner, ...v }))}`;
    // The bounded owner-scoped registry is one CAS object; removing an entry
    // drops its secret and prevents quota races or unbounded tombstone scans.
    await updateSubscriptions(entries => entries.filter(s => s.id !== id));
    return {};
  }
  async function status(task) {
    let count = 0, expiresAt = 0;
    for (const s of await subscriptions()) { if (active(s) && (!task || !s.arguments.task || s.arguments.task === task)) { count++; expiresAt = Math.max(expiresAt, s.expiresAt); } }
    return { event: EVENT_NAME, connected: count > 0, subscriptions: count, refreshBefore: expiresAt ? new Date(expiresAt).toISOString() : null };
  }
  async function queue(data, origin) {
    const event = { eventId: `cad_request_${data.requestId}`, name: EVENT_NAME, timestamp: data.createdAt, data: { requestId: data.requestId, task: data.request.task, url: `${origin}/?ai=1` }, cursor: null };
    let count = 0;
    for (const s of await subscriptions()) {
      if (!active(s) || s.createdAt > Date.parse(data.createdAt) || s.arguments.task && s.arguments.task !== data.request.task) continue;
      const key = `${root}deliveries/${data.requestId}/${s.id}.json`;
      await put(key, { subscriptionId: s.id, generation: s.generation, event, state: 'pending', attempts: 0, nextAt: now(), leaseUntil: 0 });
      count++;
    }
    return count;
  }
  async function deliverKey(key, currentRequest) {
    let item = await get(key); if (!item || item.value.state !== 'pending' || item.value.nextAt > now() || item.value.leaseUntil > now()) return;
    let d = item.value;
    const leaseId = crypto.randomUUID();
    // CAS lease avoids duplicate sends from polling tabs; stable event ID covers
    // the unavoidable accepted-delivery/storage-write crash window.
    if (!(await put(key, { ...d, leaseId, leaseUntil: now() + 29000 }, item.etag))) return;
    try {
      while (d.attempts < MAX_ATTEMPTS) {
        const request = await currentRequest(d.event.data.requestId);
        const s = await subscription(d.subscriptionId);
        if (!request || request.cancelled || request.response || !active(s) || s.generation !== d.generation) { d.state = 'stopped'; break; }
        if (d.nextAt > now()) await sleep(d.nextAt - now());
        // Re-read subscription/access-bound state immediately before each send.
        const latest = await subscription(d.subscriptionId), freshRequest = await currentRequest(d.event.data.requestId);
        if (!active(latest) || latest.generation !== d.generation || !freshRequest || freshRequest.cancelled || freshRequest.response) { d.state = 'stopped'; break; }
        d.attempts++;
        // Persist the consumed attempt before network I/O for restart bounds.
        let snapshot = await get(key);
        if (!snapshot || snapshot.value.leaseId !== leaseId || !(await put(key, { ...d, leaseId, leaseUntil: now() + 15000 }, snapshot.etag))) return;
        let response;
        try { response = await signedPost(latest, JSON.stringify(d.event), d.event.eventId); } catch { response = { ok: false, status: 0 }; }
        await response.body?.cancel();
        d.lastStatus = response.status;
        if (response.ok) { d.state = 'delivered'; break; }
        if (response.status === 410 || response.status === 413 || response.status >= 400 && response.status < 500 && ![408, 425, 429].includes(response.status)) { d.state = 'failed'; break; }
        d.nextAt = now() + 1000 * 2 ** (d.attempts - 1);
        if (d.attempts === MAX_ATTEMPTS) d.state = 'failed';
      }
    } finally {
      if (d.state === 'pending' && d.attempts >= MAX_ATTEMPTS) d.state = 'failed';
      item = await get(key); if (item?.value.leaseId === leaseId) await put(key, { ...d, leaseUntil: 0 }, item.etag);
    }
  }
  async function dispatch(requestId, currentRequest) {
    // Called only under fresh Sites authentication for this owner. No anonymous
    // cron or service identity may resume deliveries after access is revoked.
    const pending = await list(`${root}deliveries/${requestId}/`, MAX_SUBSCRIPTIONS);
    await Promise.all(pending.map(item => deliverKey(item.key, currentRequest)));
  }
  async function deliveryStatus(requestId) {
    const summary = { pending: 0, delivered: 0, failed: 0, stopped: 0 };
    for (const item of await list(`${root}deliveries/${requestId}/`, MAX_SUBSCRIPTIONS)) { const state = (await get(item.key))?.value.state; if (state in summary) summary[state]++; }
    return summary;
  }
  return { subscribe, unsubscribe, status, queue, dispatch, deliveryStatus };
}
