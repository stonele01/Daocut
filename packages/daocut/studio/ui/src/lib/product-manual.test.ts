import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyProductEdit, productRangeSummary } from './product-manual.ts';
import type { ProductAnalysis } from './product-analysis.ts';

const fixture = (): ProductAnalysis => ({
  version: 1, sources: [{ id: 's', assetPath: 'assets/live.mp4', durationMs: 12000 }],
  products: [{ id: 'a', name: '甲', sourceIds: ['s'] }, { id: 'b', name: '乙', sourceIds: ['s'] }],
  intervals: [{ id: 'a1', productId: 'a', sourceId: 's', startMs: 0, endMs: 3000 }, { id: 'b1', productId: 'b', sourceId: 's', startMs: 3000, endMs: 6000 }, { id: 'a2', productId: 'a', sourceId: 's', startMs: 7000, endMs: 10000 }],
  candidates: [{ id: 'c', intervalId: 'a2', productId: 'a', sourceId: 's', startMs: 7100, endMs: 8000, text: '甲又回来了', tags: ['卖点'], origin: 'ai-text', version: 1, runId: 'run-a2' }],
});

test('A B A rename and boundary correction retain two disjoint ranges and do not mutate the original AI document', () => {
  const original = fixture(), bytes = JSON.stringify(original);
  let next = applyProductEdit(original, { type: 'rename', productId: 'a', name: '甲商品' });
  next = applyProductEdit(next, { type: 'range', id: 'a2', sourceId: 's', productId: 'a', startMs: 7200, endMs: 9800 });
  assert.equal(JSON.stringify(original), bytes);
  assert.equal(next.products[0].name, '甲商品');
  assert.deepEqual(next.intervals.filter(i => i.productId === 'a').map(i => [i.startMs, i.endMs]), [[0, 3000], [7200, 9800]]);
  assert.deepEqual(productRangeSummary(next, 'a'), { ranges: [next.intervals[0], next.intervals[2]], count: 2, totalMs: 5600 });
  assert.deepEqual(next.intervals[1], original.intervals[1]);
  assert.deepEqual(next.candidates, original.candidates, 'AI candidate boundaries and evidence are not rewritten by a lecture boundary edit');
});

test('merging and splitting preserve independent ranges, source links and candidate references', () => {
  const original = fixture();
  const merged = applyProductEdit(original, { type: 'merge', productId: 'b', targetId: 'a' });
  assert.equal(merged.products.length, 1);
  assert.equal(merged.intervals.length, 3);
  assert.deepEqual(merged.intervals.map(i => [i.startMs, i.endMs]), original.intervals.map(i => [i.startMs, i.endMs]));
  assert.deepEqual(merged.products[0].aliases, [{ name: '乙', evidence: ['人工确认合并'] }]);
  const split = applyProductEdit(merged, { type: 'split', productId: 'a', newProductId: 'c', name: '不同套装', intervalIds: ['a2'] });
  assert.equal(split.candidates[0].productId, 'c');
  assert.equal(split.candidates[0].intervalId, 'a2');
  assert.equal(split.candidates[0].text, original.candidates[0].text);
  assert.deepEqual(split.products.find(p => p.id === 'c')?.sourceIds, ['s']);
  assert.equal(split.intervals.find(i => i.id === 'b1')?.productId, 'a');
});

test('unassign and delete preserve footage ranges and archive quotes; pending ranges can be assigned to a new product', () => {
  let next = applyProductEdit(fixture(), { type: 'unassign', intervalId: 'a2' });
  assert.equal(next.candidates.length, 0);
  assert.equal(next.archivedCandidates?.[0].text, '甲又回来了');
  assert.equal(next.unassigned?.[0].id, 'a2');
  assert.equal('productId' in next.unassigned![0], false);
  next = applyProductEdit(next, { type: 'delete-product', productId: 'a' });
  assert.deepEqual(next.unassigned?.map(i => i.id).sort(), ['a1', 'a2']);
  assert.equal(next.sources[0].assetPath, 'assets/live.mp4');
  assert.equal(next.intervals[0].productId, 'b');
  next = applyProductEdit(next, { type: 'range', id: 'a2', sourceId: 's', productId: 'new', startMs: 7000, endMs: 10000, newProductName: '确认商品' });
  assert.equal(next.unassigned?.some(i => i.id === 'a2'), false);
  assert.equal(next.intervals.find(i => i.id === 'a2')?.productId, 'new');
  assert.equal(next.archivedCandidates?.[0].text, '甲又回来了');
});

test('invalid times and identities are rejected before saving without changing the input', () => {
  const original = fixture(), bytes = JSON.stringify(original);
  for (const [startMs, endMs] of [[-1, 3000], [4000, 3000], [0, 12001], [NaN, 3000], [0, Infinity]]) {
    assert.throws(() => applyProductEdit(original, { type: 'range', id: 'a1', sourceId: 's', productId: 'a', startMs, endMs }), /范围无效/);
  }
  assert.throws(() => applyProductEdit(original, { type: 'range', id: 'a1', sourceId: 's', productId: 'missing', startMs: 0, endMs: 3000 }), /商品已变化/);
  assert.throws(() => applyProductEdit(original, { type: 'split', productId: 'a', newProductId: 'c', name: '丙', intervalIds: ['b1'] }), /请选择当前商品/);
  assert.throws(() => applyProductEdit(original, { type: 'merge', productId: 'a', targetId: 'a' }), /另一个商品/);
  assert.equal(JSON.stringify(original), bytes);
});

test('expanding a lecture over its introduction removes the now-assigned pending range and stale cue bounds', () => {
  const original = fixture();
  original.sources[0].durationMs = 1404879;
  original.intervals = [{ id: 'a1', productId: 'a', sourceId: 's', startMs: 107450, endMs: 466400 }];
  Object.assign(original.intervals[0], { firstCue: 40, lastCue: 165 });
  original.unassigned = [{ id: 'intro', sourceId: 's', startMs: 120, endMs: 107050, kind: 'transition', reason: 'AI待确认' }];
  const bytes = JSON.stringify(original);
  const next = applyProductEdit(original, { type: 'range', id: 'a1', sourceId: 's', productId: 'a', startMs: 120, endMs: 466400 });
  assert.deepEqual(next.unassigned, []);
  assert.deepEqual([next.intervals[0].startMs, next.intervals[0].endMs], [120, 466400]);
  assert.equal('firstCue' in next.intervals[0], false);
  assert.equal('lastCue' in next.intervals[0], false);
  assert.equal(JSON.stringify(original), bytes, 'the original AI document remains available for comparison');
});

test('assigning the middle of pending content retains both unassigned ends, valid IDs and only supported quotes', () => {
  const original = fixture();
  original.sources.push({ id: 'other', assetPath: 'assets/other.mp4', durationMs: 12000 });
  original.intervals = [];
  original.candidates = [];
  const left = { cue: 0, text: '前段待确认', startMs: 1000, endMs: 2000 };
  const inside = { cue: 1, text: '本次确认的商品原话', startMs: 3500, endMs: 4500 };
  const crossing = { cue: 2, text: '跨越人工边界的完整原话', startMs: 5500, endMs: 6500 };
  const right = { cue: 3, text: '后段待确认', startMs: 7000, endMs: 9000 };
  original.unassigned = [
    { id: 'pending', sourceId: 's', startMs: 1000, endMs: 9000, kind: 'mixed', reason: 'AI未确认', evidence: [left, inside, crossing, right, '无时间的依据'] },
    { id: 'other-pending', sourceId: 'other', startMs: 1000, endMs: 9000, kind: 'uncertain', reason: '另一素材' },
  ];
  Object.assign(original.unassigned[0], { firstCue: 0, lastCue: 3 });
  const next = applyProductEdit(original, { type: 'range', id: 'pending', sourceId: 's', productId: 'a', startMs: 3000, endMs: 6000 });
  const remaining = next.unassigned!.filter(i => i.sourceId === 's');
  assert.deepEqual(remaining.map(i => [i.startMs, i.endMs]), [[1000, 3000], [6000, 9000]]);
  assert.equal(new Set([...next.intervals, ...next.unassigned!].map(i => i.id)).size, 4);
  assert.deepEqual(next.intervals[0].evidence, [inside]);
  assert.deepEqual(remaining.map(i => i.evidence), [[left], [right]]);
  assert.ok(remaining.every(i => !('firstCue' in i) && !('lastCue' in i)));
  assert.deepEqual(next.unassigned!.find(i => i.sourceId === 'other'), original.unassigned[1]);
  assert.deepEqual(original.unassigned[0].evidence, [left, inside, crossing, right, '无时间的依据']);
});

test('moving a pending assignment outside its original time retains the untouched content under a distinct ID', () => {
  const original = fixture();
  original.intervals = [];
  original.candidates = [];
  original.unassigned = [{ id: 'pending', sourceId: 's', startMs: 0, endMs: 1000, kind: 'uncertain', reason: '仍需核对' }];
  const next = applyProductEdit(original, { type: 'range', id: 'pending', sourceId: 's', productId: 'a', startMs: 1000, endMs: 2000 });
  assert.equal(next.unassigned!.length, 1);
  assert.deepEqual([next.unassigned![0].startMs, next.unassigned![0].endMs], [0, 1000]);
  assert.notEqual(next.unassigned![0].id, next.intervals[0].id);
  assert.equal(next.unassigned![0].reason, original.unassigned[0].reason);
});
