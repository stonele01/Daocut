import test from 'node:test';
import assert from 'node:assert/strict';
import * as manual from './product-manual.ts';
import type { ProductAnalysis } from './product-analysis.ts';

const fixture = (): ProductAnalysis => ({ version: 1, sources: [{ id: 's', assetPath: 'assets/mock.mp4', durationMs: 651360 }], products: [{ id: 'p', name: '模拟单商品', sourceIds: ['s'] }], intervals: [], candidates: [] });
test('explicit whole-video lecture reuses range editing without inventing analysis or changing the original', () => {
  const data = fixture(), before = JSON.stringify(data);
  const next = manual.applyWholeProductLecture(data, 'p', 's');
  assert.equal(JSON.stringify(data), before);
  assert.equal(next.intervals.length, 1);
  assert.deepEqual([next.intervals[0].sourceId, next.intervals[0].productId, next.intervals[0].startMs, next.intervals[0].endMs, next.intervals[0].origin], ['s', 'p', 0, 651360, 'manual']);
  assert.deepEqual(next.candidates, []); assert.deepEqual(next.products, data.products);
  assert.throws(() => manual.applyWholeProductLecture(next, 'p', 's'), /已有|已存在/);
});
test('whole-video shortcut cannot combine returning lectures or another product', () => {
  const data = fixture();
  data.intervals = [{ id: 'one', sourceId: 's', productId: 'p', startMs: 0, endMs: 10000 }, { id: 'two', sourceId: 's', productId: 'p', startMs: 20000, endMs: 30000 }];
  assert.throws(() => manual.applyWholeProductLecture(data, 'p', 's'), /已有|已存在/);
  const mixed = fixture(); mixed.products.push({ id: 'other', name: '其他商品', sourceIds: ['s'] });
  assert.throws(() => manual.applyWholeProductLecture(mixed, 'p', 's'), /多个商品/);
});
test('whole-video shortcut requires a linked source with known duration', () => {
  const data = fixture(); data.sources[0].durationMs = null;
  assert.throws(() => manual.applyWholeProductLecture(data, 'p', 's'), /时长/);
  assert.throws(() => manual.applyWholeProductLecture(fixture(), 'p', 'missing'), /来源/);
});
