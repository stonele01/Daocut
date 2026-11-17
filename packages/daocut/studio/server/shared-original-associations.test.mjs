import test from 'node:test';
import assert from 'node:assert/strict';
import { associateOriginalAnalyses } from './shared-original-associations.mjs';
import { sharedHash } from './shared-analysis.mjs';
import { visibleProducts, productResultCandidates, productResultRanges, savedStructureRange } from '../ui/src/lib/product-analysis.ts';

function fixture() {
  const products = [{ id: 'p', name: 'Confirmed product', sourceIds: ['s'] }, ...['a', 'b', 'joined'].map((id, i) => ({ id: `copy-${id}`, name: i === 2 ? '已有拼结构 0–8秒' : `已有话术（商品待核对） ${i * 4}–${i * 4 + 4}秒`, sourceIds: ['s'] }))];
  const parts = ['a', 'b'].map((id, i) => ({ id, productId: 'p', sourceId: 's', startMs: i * 4000, endMs: (i + 1) * 4000, kind: 'confirmed-inspection', confirmed: true }));
  const sha = ['a'.repeat(64), 'b'.repeat(64)];
  const copies = parts.map((r, i) => ({ ...r, id: `history-${r.id}`, productId: `copy-${r.id}`, kind: 'historical-analysis', origin: 'shared-historical' }));
  const candidates = parts.map((r, i) => ({ id: `quote-${r.id}`, intervalId: r.id, sourceId: 's', productId: 'p', startMs: r.startMs, endMs: r.endMs, cueRange: [i, i], text: `Synthetic ${r.id}`, tags: ['卖点'], details: { reason: 'original' }, origin: 'ai-text', version: 1, runId: `run-${r.id}` }));
  const analysis = { version: 1, sources: [{ id: 's', assetPath: 'assets/test.mp4', durationMs: 8000 }], products,
    intervals: [{ id: 'joined', sourceId: 's', productId: 'p', startMs: 0, endMs: 8000, origin: 'manual', joinedScopeIds: ['a', 'b'] }],
    scopes: [...parts, ...copies, { id: 'copy-joined-scope', productId: 'copy-joined', sourceId: 's', startMs: 0, endMs: 8000, kind: 'historical-analysis', confirmed: true, origin: 'shared-composition', joinedScopeIds: ['history-a', 'history-b'], analysisRevision: sharedHash(sha) }],
    candidates: [...candidates, ...candidates.map(c => ({ ...c, id: `copy-${c.id}`, intervalId: `history-${c.intervalId}`, productId: `copy-${c.intervalId}`, runId: `import-${c.runId}` }))] };
  const records = parts.map((r, i) => ({ result: { sha256: sha[i] }, descriptor: { localScope: { intervalId: r.id, productId: 'p' } }, snapshot: { scope: { startMs: r.startMs, endMs: r.endMs }, payload: {} } }));
  const live = { analyses: Object.fromEntries(copies.map((r, i) => [r.id, { sharedRef: { sha256: sha[i] } }])) };
  return { analysis, records, live };
}

test('existing duplicate results and compositions reconnect by receipt identity without changing original data', () => {
  const { analysis, records, live } = fixture(), next = associateOriginalAnalyses(analysis, 's', live, records);
  assert.deepEqual(next.candidates, analysis.candidates);
  assert.deepEqual(next.products, analysis.products); assert.deepEqual(next.intervals, analysis.intervals);
  assert.equal(next.scopes.filter(r => r.originalScopeId).length, 3);
  assert.deepEqual(visibleProducts(next).map(p => p.id), ['p']);
  assert.deepEqual(productResultCandidates(next, 'p').map(c => c.id), ['quote-a', 'quote-b']);
  assert.ok(productResultRanges(next, 'p').some(r => r.id === 'copy-joined-scope'));
  assert.deepEqual(associateOriginalAnalyses(next, 's', live, records), next);
  assert.equal(savedStructureRange(next, next.intervals[0]).id, 'joined');
});

test('same times without provenance cannot associate a product and a changed historical version remains accessible', () => {
  const { analysis, records, live } = fixture();
  assert.deepEqual(associateOriginalAnalyses(analysis, 's', live, []), analysis);
  const unrelated = structuredClone(records); unrelated[0].descriptor.localScope.intervalId = 'unrelated';
  assert.equal(associateOriginalAnalyses(analysis, 's', live, unrelated).scopes.find(r => r.id === 'history-a').originalScopeId, undefined);
  analysis.candidates.find(c => c.id === 'copy-quote-a').details = { reason: 'previous version' };
  const next = associateOriginalAnalyses(analysis, 's', live, records);
  assert.deepEqual(productResultCandidates(next, 'p').map(c => c.id), ['quote-a', 'quote-b', 'copy-quote-a']);
  assert.deepEqual(next.candidates, analysis.candidates);
});

test('a user-confirmed recovery name is preserved and changed ordered hashes do not attach a composition', () => {
  const { analysis, records, live } = fixture();
  analysis.products.find(p => p.id === 'copy-a').name = 'User-confirmed separate product';
  const next = associateOriginalAnalyses(analysis, 's', live, records);
  assert.equal(next.scopes.find(r => r.id === 'history-a').originalScopeId, undefined);
  assert.equal(next.scopes.find(r => r.id === 'copy-joined-scope').originalScopeId, undefined);
  assert.ok(visibleProducts(next).some(p => p.name === 'User-confirmed separate product'));
  const f = fixture(); f.analysis.scopes.at(-1).analysisRevision = 'f'.repeat(64);
  assert.equal(associateOriginalAnalyses(f.analysis, 's', f.live, f.records).scopes.at(-1).originalScopeId, undefined);
});
