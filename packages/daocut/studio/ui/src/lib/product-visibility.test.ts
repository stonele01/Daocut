import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleProducts, type ProductAnalysis } from './product-analysis.ts';

test('joined lecture remnants are hidden while unanalyzed ranges, historical material and manual products remain selectable', () => {
  const data: ProductAnalysis = {
    version: 1, sources: [{ id: 'source', assetPath: 'source.mp4', durationMs: 1000 }],
    products: ['lecture', 'empty-old-a', 'empty-old-b', 'history', 'candidate-only', 'manual', 'hidden-child'].map(id => ({ id, name: id, sourceIds: ['source'], origin: id === 'manual' ? 'manual' : 'ai-discovery', ...(id === 'hidden-child' ? { joinedInto: 'lecture' } : {}) })),
    intervals: [{ id: 'joined', productId: 'lecture', sourceId: 'source', startMs: 0, endMs: 1000 }],
    scopes: [{ id: 'old-scope', productId: 'history', sourceId: 'source', startMs: 0, endMs: 500, kind: 'historical-analysis', confirmed: true }],
    candidates: [{ id: 'quote', intervalId: 'old-range', productId: 'candidate-only', sourceId: 'source', startMs: 0, endMs: 100, text: '已有话术', tags: [] }],
  };
  const original = structuredClone(data);
  assert.deepEqual(visibleProducts(data).map(p => p.id), ['lecture', 'history', 'candidate-only', 'manual']);
  assert.deepEqual(data, original, 'Visibility must not delete original product records or saved material');
});
