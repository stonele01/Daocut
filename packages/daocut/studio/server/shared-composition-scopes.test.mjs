import test from 'node:test';
import assert from 'node:assert/strict';
import { sharedCompositionScopes } from './shared-composition-scopes.mjs';
import { sharedHash } from './shared-analysis.mjs';

const seed = () => ({ version: 1, sources: [{ id: 's', assetPath: 'assets/a.mp4', durationMs: 9000 }], products: [{ id: 'p', name: '私人名称', sourceIds: ['s'] }], intervals: [],
  scopes: [{ id: 'a', sourceId: 's', productId: 'p', startMs: 0, endMs: 4000, kind: 'historical-analysis', confirmed: true },
    { id: 'b', sourceId: 's', productId: 'p', startMs: 4100, endMs: 9000, kind: 'historical-analysis', confirmed: true }], candidates: [] });
const live = { analyses: { a: { sharedRef: { sha256: 'a'.repeat(64) } }, b: { sharedRef: { sha256: 'b'.repeat(64) } } } };
const row = { catalog: { action: 'structure-plans', scope: { startMs: 0, endMs: 9000 }, provenance: { inputRevision: sharedHash(['a'.repeat(64), 'b'.repeat(64)]) } } };
test('published composition recovers exact ordered baseline hashes without altering product names or lecture boundaries', () => {
  const input = seed(), next = sharedCompositionScopes(input, 's', live, [row, row]);
  assert.equal(input.scopes.length, 2);
  assert.equal(next.scopes.length, 3);
  assert.deepEqual(next.scopes[2].joinedScopeIds, ['a', 'b']);
  assert.deepEqual(next.intervals, input.intervals);
  assert.deepEqual(next.products[0], input.products[0]);
  assert.deepEqual(sharedCompositionScopes(next, 's', live, [row]), next);
});
test('time overlap alone, reversed hashes and duplicate baselines cannot restore a composition', () => {
  const input = seed();
  for (const revision of ['f'.repeat(64), sharedHash(['b'.repeat(64), 'a'.repeat(64)])]) {
    assert.deepEqual(sharedCompositionScopes(input, 's', live, [{ catalog: { ...row.catalog, provenance: { inputRevision: revision } } }]), input);
  }
  input.scopes.push({ ...input.scopes[0], id: 'duplicate' });
  assert.deepEqual(sharedCompositionScopes(input, 's', { analyses: { ...live.analyses, duplicate: live.analyses.a } }, [row]), input);
});
