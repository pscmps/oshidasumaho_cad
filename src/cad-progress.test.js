import test from 'node:test';
import assert from 'node:assert/strict';
import { describeProgress, elapsedLabel } from './ai-adapter/progress.js';
import { createMeshCache } from './cad-core/mesh-cache.js';
import { emptyCad } from './cad-core/document.js';
const doc = () => ({ schemaVersion: 5, shapes: [], cad: emptyCad() });

test('waiting never represents callback acceptance or elapsed time as AI execution or percent', () => {
  for (const webhook of [{}, { connected: true }, { delivered: 1 }, { failed: 1 }, { unavailable: true }]) {
    const view = describeProgress({ phase: 'waiting', webhook, startedAt: 1000 }, 121000);
    assert.equal(view.label, '受付済み・dotの応答待ち');
    assert.equal(view.elapsed, '2分0秒'); assert.ok(view.longWait);
    assert.ok(!JSON.stringify(view).match(/AI実行中|\d+%|残り\d/));
  }
  const delivered = describeProgress({ phase: 'waiting', webhook: { delivered: 1 } });
  assert.match(delivered.detail, /実行開始は未確認/);
  assert.equal(describeProgress({ phase: 'waiting', webhook: { failed: 1 } }).busy, false);
  assert.equal(describeProgress({ phase: 'clarification' }).busy, false);
  assert.equal(describeProgress({ phase: 'paused', requestId: 'saved' }).retry, true);
  assert.equal(describeProgress({ phase: 'cancelled', requestId: 'saved' }).retry, false);
  assert.equal(elapsedLabel(-500), '0秒');
});

test('mesh reuse coalesces in-flight work and detaches results, while respecting changed geometry', async () => {
  let calls = 0, finish;
  const cache = createMeshCache(async () => { calls++; await new Promise(r => finish = r); return { bodies: [{ name: 'unchanged' }] }; });
  const original = doc(), a = cache(original), b = cache(structuredClone(original));
  await Promise.resolve(); assert.equal(calls, 1); finish();
  const results = await Promise.all([a,b]); results[0].bodies[0].name = 'mutated';
  assert.equal(results[1].bodies[0].name, 'unchanged');
  const editedNotes = structuredClone(original); editedNotes.cad.draft.notes = 'different text';
  assert.equal((await cache(editedNotes)).bodies[0].name, 'unchanged'); assert.equal(calls, 1);
  const changed = structuredClone(original); changed.cad.suppressedProjection = true;
  const next = cache(changed); await Promise.resolve(); assert.equal(calls, 2); finish(); await next;
});

test('mesh reuse validates every document, excludes failures and has bounded memory retention', async () => {
  let calls = 0;
  const cache = createMeshCache(async () => { if (++calls === 1) throw new Error('kernel failed'); return { bodies: [] }; });
  await assert.rejects(cache(doc()), /kernel failed/); await cache(doc()); assert.equal(calls, 2);
  const invalid = doc(); invalid.cad.appliedRequestIds = ['invalid'];
  await assert.rejects(cache(invalid), /履歴/); assert.equal(calls, 2);
  for (let i = 1; i <= 3; i++) await cache({ ...doc(), partName: String(i) });
  await cache(doc()); assert.equal(calls, 6, 'evicted entries are recomputed');
  let largeCalls = 0;
  const large = createMeshCache(async () => { largeCalls++; return { bodies: [], oversized: 'x'.repeat(1000) }; }, { maxBytes: 10 });
  await large(doc()); await large(doc()); assert.equal(largeCalls, 2);
});

test('legacy projection constraints participate in mesh cache identity', async () => {
  let calls = 0; const cache = createMeshCache(async () => { calls++; return { bodies: [] }; });
  await cache(doc()); await cache({ ...doc(), areaLocks: { top: true } });
  await cache({ ...doc(), areaLocks: { top: true }, areaLockConstraints: { top: { width: 30 } } });
  assert.equal(calls, 3);
});
