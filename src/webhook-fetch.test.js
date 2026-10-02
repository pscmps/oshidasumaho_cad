import test from 'node:test';
import assert from 'node:assert/strict';
import { webhookFetch } from './webhook-fetch.js';

const url = 'https://receiver.example.com/private-callback-marker';
const options = () => ({ method: 'POST', headers: { 'webhook-signature': 'private-signature-marker' }, body: '{"challenge":"private-challenge-marker"}', signal: AbortSignal.timeout(1000) });

test('hosted transport uses a Workers-supported non-following mode and preserves signed bytes', async t => {
  const sent = options(), response = Response.json({ challenge: 'private-challenge-marker' });
  const fetch = t.mock.method(globalThis, 'fetch', async (target, init) => {
    assert.equal(target, url);
    if (!['follow', 'manual'].includes(init.redirect)) throw new TypeError('Invalid redirect value');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.method, 'POST');
    assert.equal(init.body, sent.body);
    assert.equal(init.headers, sent.headers);
    assert.equal(init.signal, sent.signal);
    assert.equal(init.cf, undefined);
    return response;
  });
  assert.equal(await webhookFetch(url, { ...sent, redirect: 'follow', cf: { resolveOverride: 'ignored' } }), response);
  assert.equal(fetch.mock.callCount(), 1);
});

test('all 3xx variants and opaque redirects are rejected without reading or following Location', async t => {
  let cancelled = 0, current;
  const fetch = t.mock.method(globalThis, 'fetch', async () => current);
  const messages = [];
  t.mock.method(console, 'info', value => messages.push(value));
  t.mock.method(console, 'warn', value => messages.push(value));
  const cases = [300, 301, 302, 303, 304, 305, 307, 308, 399].map(status => ({ status }));
  cases.push({ status: 0, type: 'opaqueredirect' }, { status: 200, redirected: true });
  for (const item of cases) {
    current = { ...item, body: { cancel: async () => { cancelled++; } }, get headers() { throw new Error('Location must never be read'); } };
    await assert.rejects(webhookFetch(url, options()), /Webhook redirect rejected/);
  }
  assert.equal(fetch.mock.callCount(), cases.length);
  assert.equal(cancelled, cases.length);
  assert.equal(messages.join('').includes('private-'), false);
});

test('unsafe callback destinations fail before fetch', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Network must not be called'); });
  for (const target of ['http://receiver.example.com', 'https://127.0.0.1', 'https://[::1]', 'https://a.internal', 'https://receiver.example.com:8443', 'https://user:pass@receiver.example.com', 'https://chatgpt.site', 'https://another.chatgpt.site']) {
    await assert.rejects(webhookFetch(target, options()));
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test('transport errors retain their identity but diagnostics expose only fixed labels', async t => {
  const failure = new TypeError('TLS private-secret-marker at ' + url), messages = [];
  t.mock.method(globalThis, 'fetch', async () => { throw failure; });
  t.mock.method(console, 'info', value => messages.push(value));
  t.mock.method(console, 'warn', value => messages.push(value));
  await assert.rejects(webhookFetch(url, options()), error => error === failure);
  assert.equal(JSON.parse(messages.at(-1)).reason, 'tls');
  assert.equal(messages.join('').includes('private-'), false);
});
