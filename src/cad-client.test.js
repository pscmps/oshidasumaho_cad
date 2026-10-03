import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCodexAdapter } from './ai-adapter/codex.js';
import * as adapters from './ai-adapter/index.js';
import * as documents from './cad-core/document.js';
import * as proposals from './cad-command/proposals.js';
import * as sketches from './cad-core/rough-sketch.js';
import * as schema from './cad-command/schema.js';

const id = 'e3ad1234-1234-4123-8123-123456789abc';
const command = { operation: 'addExtrude', profile: { type: 'rectangle', width: 20, height: 20 }, distance: 5, origin: [0, 0, 0] };
const document = () => ({ schemaVersion: 5, shapes: [], cad: documents.emptyCad() });
const snapshot = () => ({ task: 'sketch', document: document(), sketchDraft: sketches.emptyDraft(), prompt: 'part' });

test('one reader aborts without cancelling another reader or making any POST', async () => {
  const calls = [], controller = new AbortController(); let answered = false;
  const fetcher = async (url, options = {}) => {
    calls.push([url, options.method || 'GET']);
    return Response.json({ request: snapshot(), response: answered ? { commands: [command] } : { clarification: 'Which size?' } });
  };
  const reader = createCodexAdapter({ fetcher, interval: 1, onClarification: () => controller.abort() });
  await assert.rejects(reader.resume(id, { signal: controller.signal }), { name: 'AbortError' });
  answered = true;
  const saved = await createCodexAdapter({ fetcher }).resume(id);
  assert.deepEqual(saved.response.commands, [command]);
  assert.equal(saved.response.requestId, id);
  assert.ok(calls.every(([, method]) => method === 'GET'));
});

test('explicit cancel sends one POST and exposes server failure without retry', async () => {
  const calls = [];
  const adapter = createCodexAdapter({ retryDelay: 0, fetcher: async (url, options) => {
    calls.push([url, options.method]); return Response.json({ error: '取消を保存できません' }, { status: 503 });
  } });
  await assert.rejects(adapter.cancel(id), /取消を保存できません/);
  assert.deepEqual(calls, [['/api/cad/requests/' + id + '/cancel', 'POST']]);
  await assert.rejects(adapter.cancel('../other'), /依頼番号/);
  assert.equal(calls.length, 1);
});

test('GET retries transient responses and network errors at most three times, then fails', async () => {
  for (const status of [408, 429, 500, 502, 503, 'network']) {
    let attempts = 0;
    const adapter = createCodexAdapter({ retryDelay: 0, fetcher: async () => {
      attempts++;
      if (status === 'network') throw new TypeError('offline');
      return Response.json({ error: 'temporary' }, { status });
    } });
    await assert.rejects(adapter.recent());
    assert.equal(attempts, 4, 'one initial attempt plus three bounded retries: ' + status);
  }
  for (const status of [400, 401, 403, 404, 409]) {
    let attempts = 0;
    await assert.rejects(createCodexAdapter({ retryDelay: 0, fetcher: async () => { attempts++; return Response.json({ error: 'stop' }, { status }); } }).recent());
    assert.equal(attempts, 1, 'non-transient status does not retry');
  }
});

test('GET recovers within its bound; an aborted backoff stops before another fetch', async () => {
  let attempts = 0;
  const adapter = createCodexAdapter({ retryDelay: 0, fetcher: async () => {
    if (++attempts < 4) return new Response(null, { status: 503 });
    return Response.json({ connected: true });
  } });
  assert.equal((await adapter.connection()).connected, true); assert.equal(attempts, 4);
  const controller = new AbortController(); let abortedAttempts = 0;
  const stopped = createCodexAdapter({ retryDelay: 20, fetcher: async () => {
    abortedAttempts++; setTimeout(() => controller.abort(), 0); return new Response(null, { status: 503 });
  } });
  await assert.rejects(stopped.recent({ signal: controller.signal }), { name: 'AbortError' });
  assert.equal(abortedAttempts, 1);
});

test('failed submission is never retried; successful response carries its generated request ID', async () => {
  let attempts = 0;
  await assert.rejects(createCodexAdapter({ retryDelay: 0, fetcher: async () => { attempts++; throw new TypeError('network'); } }).propose(snapshot()));
  assert.equal(attempts, 1);
  let generated;
  const adapter = createCodexAdapter({ fetcher: async (url, options = {}) => {
    if (options.method === 'POST') { generated = JSON.parse(options.body).requestId; return Response.json({ requestId: generated }); }
    return Response.json({ response: { commands: [command] } });
  } });
  assert.equal((await adapter.propose(snapshot())).requestId, generated);
  const edit = await adapters.interpretPrompt(document(), 'Please make an unspecified part', { adapter: { propose: async () => ({ commands: [command], requestId: id }) } });
  assert.equal(edit.proposal.requestId, id);
});

// Run the real hook's actions with inert rendering and a controllable kernel. This
// tests async commit ordering without a browser/WebGL dependency. Browser smoke
// coverage separately checks the rendered controls and proposal geometry.
function workspaceHarness({ proposal, adapterFactory, pending = false } = {}) {
  const original = document(), writes = [], saved = [], status = [], staged = [];
  let stateIndex = 0, resolveKernel, kernelCalls = 0;
  const kernel = new Promise(resolve => { resolveKernel = resolve; });
  const useState = initial => {
    const index = ++stateIndex;
    const value = index === 6 ? proposal || null : index === 7 ? pending : typeof initial === 'function' ? initial() : initial;
    return [value, next => { if (index === 6) staged.push(next); if (index === 9) status.push(next); }];
  };
  const deps = { ...documents, ...proposals, ...sketches, ...schema, ...adapters,
    useState, useRef: current => ({ current }), useEffect: () => {},
    createCodexAdapter: adapterFactory || createCodexAdapter,
    evaluateInWorker: () => { kernelCalls++; return kernel; },
    withDocumentWriteLock: action => Promise.resolve().then(action),
    persistDocumentChange: (current, candidate) => writes.push({ current, candidate }),
    window: { location: { href: 'https://cad.test/?ai=1' }, history: { replaceState: () => {} }, oshidaCadAIAdapter: undefined },
  };
  const source = readFileSync(new URL('./ui/useCadWorkspace.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace('export function useCadWorkspace', 'function useCadWorkspace')
    .replaceAll('import.meta.env.VITE_SITE_CODEX', JSON.stringify(adapterFactory ? '1' : '0'));
  const hook = new Function(...Object.keys(deps), source + '\nreturn useCadWorkspace;')(...Object.values(deps));
  const workspace = hook(original, value => saved.push(value), false);
  assert.equal(workspace.proposal, proposal || null, 'harness targets the actual proposal state');
  return { workspace, original, writes, saved, status, staged, resolveKernel, get kernelCalls() { return kernelCalls; } };
}

test('apply double click commits once and cancellation during kernel evaluation commits nothing', async () => {
  const p = proposals.createProposal(document(), [command]);
  const h = workspaceHarness({ proposal: p });
  const first = h.workspace.applyProposal(), duplicate = h.workspace.applyProposal();
  await Promise.resolve(); assert.equal(h.kernelCalls, 1);
  h.resolveKernel({ bodies: [] }); await Promise.all([first, duplicate]);
  assert.equal(h.writes.length, 1); assert.equal(h.saved.length, 1); assert.equal(h.saved[0].cad.features.length, 1);
  const cancelled = workspaceHarness({ proposal: p });
  const applying = cancelled.workspace.applyProposal(); await Promise.resolve();
  await cancelled.workspace.cancel(); cancelled.resolveKernel({ bodies: [] }); await applying;
  assert.equal(cancelled.writes.length, 0); assert.equal(cancelled.saved.length, 0);
  assert.equal(cancelled.status.at(-1), 'キャンセルしました');
});

test('starting another request while apply is evaluating prevents that old apply from committing', async () => {
  const h = workspaceHarness({ proposal: proposals.createProposal(document(), [command]) });
  const applying = h.workspace.applyProposal(); await Promise.resolve();
  await h.workspace.submit('Please reconsider the vague shape');
  h.resolveKernel({ bodies: [] }); await applying;
  assert.equal(h.writes.length, 0); assert.equal(h.saved.length, 0);
});

test('restored proposals keep their request ID; a failed explicit cancel is visible in workspace status', async () => {
  const r = snapshot();
  const h = workspaceHarness({ pending: true, adapterFactory: () => ({
    resume: async () => ({ request: r, response: { commands: [command] } }),
    cancel: async () => { throw new Error('temporary cancellation failure'); },
  }) });
  await h.workspace.resumeRequest(id);
  assert.equal(h.staged.at(-1).requestId, id);
  await h.workspace.cancel();
  assert.match(h.status.at(-1), /取消を確認できません/);
  assert.match(h.status.at(-1), /temporary cancellation failure/);
  assert.equal(h.saved.length, 0);
});


test('cancel before a queued document lock begins prevents evaluation and saving', async () => {
  const h = workspaceHarness({ proposal: proposals.createProposal(document(), [command]) });
  const applying = h.workspace.applyProposal();
  await h.workspace.cancel();
  await applying;
  assert.equal(h.kernelCalls, 0); assert.equal(h.writes.length, 0); assert.equal(h.saved.length, 0);
});

test('interrupted GET response bodies retry, but malformed JSON never does', async () => {
  let attempts = 0;
  const adapter = createCodexAdapter({ retryDelay: 0, fetcher: async () => {
    attempts++;
    return attempts < 3 ? { ok: true, json: async () => { throw new TypeError('stream interrupted'); } } : Response.json({ requests: [] });
  } });
  assert.deepEqual(await adapter.recent(), []); assert.equal(attempts, 3);
  let malformed = 0;
  await assert.rejects(createCodexAdapter({ retryDelay: 0, fetcher: async () => { malformed++; return new Response('{broken'); } }).recent(), SyntaxError);
  assert.equal(malformed, 1);
});


test('immediate undo saves the restored model and request receipt before the next render', async () => {
  const p = proposals.createProposal(document(), [command]); p.requestId = id;
  const h = workspaceHarness({ proposal: p });
  const applying = h.workspace.applyProposal(); await Promise.resolve();
  h.resolveKernel({ bodies: [] }); await applying;
  assert.deepEqual(h.saved[0].cad.appliedRequestIds, [id]);
  await h.workspace.undo();
  assert.equal(h.writes.length, 2); assert.equal(h.saved.length, 2);
  assert.equal(h.saved[1].cad.features.length, 0);
  assert.deepEqual(h.saved[1].cad.appliedRequestIds || [], []);
  assert.deepEqual(h.writes[1].current, h.saved[0]);
  assert.deepEqual(h.writes[1].candidate, h.saved[1]);
});


test('progress distinguishes saved, delivered, clarification and returned proposal; no AI-running claim', async () => {
  const progress = [], states = [
    { webhook: { connected: true, pending: 1 } },
    { webhook: { connected: true, delivered: 1 } },
    { response: { clarification: 'Which size?' }, responseRevision: 1 },
    { response: { commands: [command] }, responseRevision: 2, responseAt: '2026-10-03T01:00:00Z' },
  ];
  const adapter = createCodexAdapter({ interval: 1, onProgress: value => progress.push(value), fetcher: async () => Response.json({ request: snapshot(), createdAt: '2026-10-03T00:59:00Z', ...states.shift() }) });
  await adapter.resume(id);
  assert.deepEqual(progress.map(p => p.phase), ['waiting', 'waiting', 'clarification', 'received']);
  assert.equal(progress[1].webhook.delivered, 1);
  assert.equal(progress.at(-1).responseAt, '2026-10-03T01:00:00Z');
  assert.ok(progress.every(p => p.checkedAt && p.requestId === id));
});

test('bounded waiting pauses honestly and resuming does not submit another request', async () => {
  let now = 0; const phases = [], methods = [];
  const adapter = createCodexAdapter({ timeoutMs: 5000, interval: 1800, now: () => now, sleep: async ms => { now += ms; }, onProgress: p => phases.push(p.phase), fetcher: async (url, options) => { methods.push(options.method || 'GET'); return Response.json({ request: snapshot(), response: null }); } });
  await assert.rejects(adapter.resume(id), /応答待ちを終了/);
  assert.equal(methods.length, 3); assert.ok(methods.every(m => m === 'GET'));
  assert.equal(phases.at(-1), 'paused');
});

test('progress exposes bounded communication retries and a cancelled saved request', async () => {
  let attempts = 0; const phases = [];
  const adapter = createCodexAdapter({ retryDelay: 0, onProgress: p => phases.push(p), fetcher: async () => ++attempts === 1 ? new Response(null, { status: 503 }) : Response.json({ request: snapshot(), cancelled: true }) });
  await assert.rejects(adapter.resume(id), e => e.code === 'REQUEST_CANCELLED');
  assert.equal(phases[0].phase, 'retrying'); assert.equal(phases[0].retryAttempt, 1);
  assert.equal(phases.at(-1).phase, 'cancelled'); assert.equal(attempts, 2);
});
