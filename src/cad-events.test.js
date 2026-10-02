import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createEvents, EVENT_NAME, signingKey, callbackUrl, canonical } from './cad-events.js';

class Bucket {
  items = new Map(); serial = 0;
  async get(key) { const v = this.items.get(key); return v && { etag: v.etag, json: async () => JSON.parse(v.text) }; }
  async put(key, text, options = {}) {
    const old = this.items.get(key), cond = options.onlyIf;
    if (cond?.etagMatches && old?.etag !== cond.etagMatches || cond?.etagDoesNotMatch === '*' && old) return null;
    const etag = String(++this.serial); this.items.set(key, { text, etag }); return { etag };
  }
  async list({ prefix, limit = 1000 }) { return { objects: [...this.items.keys()].filter(k => k.startsWith(prefix)).slice(0, limit).map(key => ({ key })), truncated: false }; }
}
const secret = 'whsec_' + Buffer.alloc(32, 11).toString('base64');
const nextSecret = 'whsec_' + Buffer.alloc(32, 12).toString('base64');
const params = (args = {}, extra = {}) => ({ name: EVENT_NAME, arguments: args, delivery: { mode: 'webhook', url: 'https://receiver.example.com/callback/abc', secret }, cursor: null, ...extra });
const requestId = 'a7c7c4a8-9005-49e2-91e8-568cd4b68212';
function harness() {
  const bucket = new Bucket(), sent = []; let time = Date.parse('2026-10-02T12:00:00Z'), responses = [], failChallenge = false;
  const deps = { now: () => time, sleep: async ms => { time += ms; }, webhookFetch: async (url, options) => {
    const body = JSON.parse(options.body); sent.push({ url, ...options, parsed: body });
    if (body.type === 'verification') return Response.json({ challenge: failChallenge ? 'wrong' : body.challenge });
    const status = responses.shift() ?? 200; if (status === 0) throw new Error('network failure');
    return new Response(null, { status });
  } };
  const events = createEvents(bucket, 'alice', deps);
  const data = task => ({ requestId, request: { task: task ?? 'sketch' }, createdAt: new Date(time).toISOString(), cancelled: false });
  return { bucket, sent, deps, events, data, advance: ms => { time += ms; }, respond: values => { responses = [...values]; }, badChallenge: () => { failChallenge = true; } };
}
function checkSignature(sent, key = secret) {
  const h = sent.headers;
  const signature = createHmac('sha256', Buffer.from(key.slice(6), 'base64')).update(`${h['webhook-id']}.${h['webhook-timestamp']}.${sent.body}`).digest('base64');
  assert.ok(h['webhook-signature'].split(' ').includes(`v1,${signature}`));
  assert.equal(sent.redirect, 'manual'); assert.equal(h['Content-Type'], 'application/json');
}

test('subscription verification, canonical identity, refresh and restart persistence', async () => {
  const h = harness(), first = await h.events.subscribe(params({ task: 'sketch' }));
  assert.match(first.id, /^sub_[a-f0-9]{64}$/); assert.equal(first.cursor, null); assert.equal(first.truncated, false);
  checkSignature(h.sent[0]); assert.equal(h.sent[0].parsed.type, 'verification');
  const restart = createEvents(h.bucket, 'alice', h.deps);
  assert.equal((await restart.status()).connected, true);
  const refresh = await restart.subscribe(params({ task: 'sketch' }, { ttlMs: 10000 }));
  assert.equal(refresh.id, first.id); assert.equal(h.sent.length, 1, 'bounded successful verification cache');
  h.advance(10001); assert.equal((await restart.status()).connected, false);
  assert.equal(canonical({ b: { y: 1, a: 2 }, a: 1 }), canonical({ a: 1, b: { a: 2, y: 1 } }));
});

test('signing-key rotation signs both keys briefly, then drops the old signature', async () => {
  const h = harness(); await h.events.subscribe(params());
  const changed = params(); changed.delivery.secret = nextSecret;
  await h.events.subscribe(changed); const d = h.data(); await h.events.queue(d, 'https://cad.test');
  await h.events.dispatch(requestId, async () => d);
  const event = h.sent.at(-1); checkSignature(event, secret); checkSignature(event, nextSecret);
  h.advance(61000);
  const d2 = { ...h.data(), requestId: 'b7c7c4a8-9005-49e2-91e8-568cd4b68212' };
  await h.events.queue(d2, 'https://cad.test'); await h.events.dispatch(d2.requestId, async () => d2);
  assert.equal(h.sent.at(-1).headers['webhook-signature'].split(' ').length, 1); checkSignature(h.sent.at(-1), nextSecret);
});

test('explicit submission delivers exactly one minimal event; duplicate queue/drain is safe', async () => {
  const h = harness(), s = await h.events.subscribe(params()), d = h.data();
  await h.events.queue(d, 'https://cad.test'); await h.events.queue(d, 'https://cad.test');
  await Promise.all([h.events.dispatch(requestId, async () => d), h.events.dispatch(requestId, async () => d)]);
  await h.events.dispatch(requestId, async () => d);
  assert.equal(h.sent.length, 2); const e = h.sent[1]; checkSignature(e);
  assert.equal(e.headers['X-MCP-Subscription-Id'], s.id); assert.equal(e.headers['webhook-id'], e.parsed.eventId);
  assert.deepEqual(e.parsed.data, { requestId, task: 'sketch', url: 'https://cad.test/?ai=1&cadRequest=' + requestId });
  assert.deepEqual(await h.events.deliveryStatus(requestId), { pending: 0, delivered: 1, failed: 0, stopped: 0 });
});

test('filters, principal ownership, unsubscribe and canceled requests stop delivery', async () => {
  const h = harness(); await h.events.subscribe(params({ task: 'edit' }));
  assert.equal(await h.events.queue(h.data('sketch'), 'https://cad.test'), 0);
  const bob = createEvents(h.bucket, 'bob', h.deps); assert.equal((await bob.status()).connected, false);
  const stop = params({ task: 'edit' }); delete stop.delivery.secret; delete stop.cursor;
  await bob.unsubscribe(stop); assert.equal((await h.events.status()).connected, true);
  const d = h.data('edit'); await h.events.queue(d, 'https://cad.test');
  await h.events.unsubscribe(stop); await h.events.unsubscribe(stop);
  await h.events.dispatch(requestId, async () => d); assert.equal(h.sent.length, 1);
  assert.equal((await h.events.deliveryStatus(requestId)).stopped, 1);
  const h2 = harness(); await h2.events.subscribe(params()); const d2 = { ...h2.data(), cancelled: true };
  await h2.events.queue(d2, 'https://cad.test'); await h2.events.dispatch(requestId, async () => d2); assert.equal(h2.sent.length, 1);
});

test('bounded exponential retries preserve event bytes and ID but refresh signatures', async () => {
  const h = harness(); await h.events.subscribe(params()); const d = h.data(); h.respond([503, 429, 200]);
  await h.events.queue(d, 'https://cad.test'); await h.events.dispatch(requestId, async () => d);
  const events = h.sent.slice(1); assert.equal(events.length, 3);
  assert.equal(new Set(events.map(e => e.body)).size, 1);
  assert.equal(new Set(events.map(e => e.headers['webhook-timestamp'])).size, 3);
  events.forEach(e => checkSignature(e)); assert.equal((await h.events.deliveryStatus(requestId)).delivered, 1);
});

test('410 and 413 never retry; transient failures stop at max attempts', async () => {
  for (const failures of [[410], [413], [0, 503, 503]]) {
    const h = harness(); await h.events.subscribe(params()); const d = h.data(); h.respond(failures);
    await h.events.queue(d, 'https://cad.test'); await h.events.dispatch(requestId, async () => d); await h.events.dispatch(requestId, async () => d);
    assert.equal(h.sent.length, failures.length + 1); assert.equal((await h.events.deliveryStatus(requestId)).failed, 1);
    assert.equal((await h.events.status()).connected, true, 'a single delivery failure does not terminate the subscription');
  }
});

test('interrupted lease and persisted attempts resume after restart; no replay before subscribing', async () => {
  const h = harness(), before = h.data(); h.advance(1); await h.events.subscribe(params());
  assert.equal(await h.events.queue(before, 'https://cad.test'), 0);
  const d = h.data(); await h.events.queue(d, 'https://cad.test');
  const [key, row] = [...h.bucket.items].find(([k]) => k.includes('/deliveries/'));
  const initial = JSON.parse(row.text); await h.bucket.put(key, JSON.stringify({ ...initial, attempts: 1, leaseUntil: h.deps.now() + 1000 }));
  const restart = createEvents(h.bucket, 'alice', h.deps); await restart.dispatch(requestId, async () => d); assert.equal(h.sent.length, 1);
  h.advance(1001); h.respond([503, 503]); await restart.dispatch(requestId, async () => d);
  assert.equal(h.sent.length, 3); assert.equal((await restart.deliveryStatus(requestId)).failed, 1);
});

test('invalid destinations/keys, unknown filters and failed verification never activate', async () => {
  const h = harness();
  for (const url of ['http://receiver.example.com/x', 'https://127.0.0.1/x', 'https://2130706433/x', 'https://[::1]/x', 'https://a.local/x', 'https://user:pw@receiver.example.com/x', 'https://receiver.example.com:8080/x', 'https://receiver.example.com/x#fragment']) assert.throws(() => callbackUrl(url));
  for (const key of ['wrong', 'whsec_Zm9v', 'whsec_' + Buffer.alloc(65).toString('base64')]) assert.throws(() => signingKey(key));
  await assert.rejects(h.events.subscribe(params({ unknown: true })), e => e.code === -32602);
  await assert.rejects(h.events.subscribe(params({}, { ttlMs: -1 })), e => e.code === -32602);
  h.badChallenge(); await assert.rejects(h.events.subscribe(params()), e => e.code === -32015 && e.data.reason === 'challenge_failed');
  assert.equal((await h.events.status()).connected, false);
  assert.ok(!JSON.stringify(await h.events.status()).includes(secret));
});

test('concurrent subscriptions respect the atomic owner quota; repeated turnover stays bounded', async () => {
  const h = harness(), subscriptions = Array.from({ length: 11 }, (_, i) => { const p = params(); p.delivery.url += i; return p; });
  const result = await Promise.allSettled(subscriptions.map(p => h.events.subscribe(p)));
  assert.ok(result.filter(r => r.status === 'fulfilled').length <= 10);
  assert.ok(result.some(r => r.status === 'rejected'));
  for (const p of subscriptions) { const stop = { name: p.name, arguments: p.arguments, delivery: { mode: 'webhook', url: p.delivery.url } }; await h.events.unsubscribe(stop); }
  for (let i = 0; i < 105; i++) { const p = params(); p.delivery.url += i; await h.events.subscribe(p); await h.events.unsubscribe({ name: p.name, arguments: {}, delivery: { mode: 'webhook', url: p.delivery.url } }); }
  await h.events.subscribe(params()); assert.equal((await h.events.status()).subscriptions, 1);
});

test('resubscribe never revives an old delivery; exhausted restart becomes failed', async () => {
  const h = harness(); await h.events.subscribe(params()); const d = h.data(); await h.events.queue(d, 'https://cad.test');
  await h.events.unsubscribe({ name: EVENT_NAME, arguments: {}, delivery: { mode: 'webhook', url: params().delivery.url } });
  await h.events.subscribe(params()); await h.events.dispatch(requestId, async () => d);
  assert.equal((await h.events.deliveryStatus(requestId)).stopped, 1); assert.equal(h.sent.filter(s => !s.parsed.type).length, 0);
  const h2 = harness(); await h2.events.subscribe(params()); const d2 = h2.data(); await h2.events.queue(d2, 'https://cad.test');
  const [key, row] = [...h2.bucket.items].find(([k]) => k.includes('/deliveries/'));
  await h2.bucket.put(key, JSON.stringify({ ...JSON.parse(row.text), attempts: 3 }));
  await h2.events.dispatch(requestId, async () => d2); assert.equal((await h2.events.deliveryStatus(requestId)).failed, 1);
});

test('transient storage faults keep pending work retryable and 425 retries safely', async () => {
  const h = harness(); await h.events.subscribe(params()); const d = h.data(); await h.events.queue(d, 'https://cad.test');
  await assert.rejects(h.events.dispatch(requestId, async () => { throw new Error('R2 temporarily unavailable'); }));
  assert.equal((await h.events.deliveryStatus(requestId)).pending, 1);
  h.respond([425, 200]); await h.events.dispatch(requestId, async () => d); assert.equal((await h.events.deliveryStatus(requestId)).delivered, 1);
});
