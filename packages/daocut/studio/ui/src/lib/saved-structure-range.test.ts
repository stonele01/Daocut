import test from 'node:test';
import assert from 'node:assert/strict';
import { savedStructureRange, productAnalysisRange, productResultCandidates, visibleProducts, type ProductAnalysis } from './product-analysis.ts';

const seed = (): ProductAnalysis => ({ version: 1, sources: [{ id: 's', assetPath: 'assets/a.mp4', durationMs: 6000000 }],
  products: [{ id: 'jacket', name: '羽绒服', sourceIds: ['s'] }, { id: 'saved', name: '已有拼结构', sourceIds: ['s'] }],
  intervals: [{ id: 'lecture', savedResultScopeId: 'original-composition', productId: 'jacket', sourceId: 's', startMs: 4141200, endMs: 5172760 }],
  scopes: [{ id: 'original-composition', productId: 'saved', sourceId: 's', startMs: 4141200, endMs: 5172760,
    kind: 'historical-analysis', confirmed: true, origin: 'shared-composition', joinedScopeIds: ['first', 'second'] }], candidates: [] });

test('viewing either old part keeps the current complete lecture as the analysis target', () => {
  const a = seed();
  a.intervals[0]!.joinedScopeIds = ['first', 'second'];
  for (const id of ['first', 'second']) {
    const part = { ...a.intervals[0]!, id, joinedScopeIds: undefined, kind: 'confirmed-inspection' as const };
    assert.equal(productAnalysisRange(a, 'jacket', part)?.id, 'lecture');
  }
  assert.equal(productAnalysisRange(a, 'jacket', a.scopes![0])?.id, 'lecture');
});

test('separate return lectures keep their own identity and an unrelated historical view cannot merge them', () => {
  const a = seed();
  a.intervals.push({ ...a.intervals[0]!, id: 'return', savedResultScopeId: undefined, startMs: 5500000, endMs: 5900000 });
  assert.equal(productAnalysisRange(a, 'jacket', a.intervals[1])?.id, 'return');
  assert.equal(productAnalysisRange(a, 'jacket', a.scopes![0])?.id, 'lecture');
  assert.equal(productAnalysisRange(a, 'jacket', { ...a.scopes![0]!, id: 'unrelated' }), undefined);
});

test('ordinary product entry uses the explicit saved scope and keeps all persisted identities', () => {
  const analysis = seed(), before = structuredClone(analysis);
  assert.equal(savedStructureRange(analysis, analysis.intervals[0]!).id, 'original-composition');
  assert.deepEqual(analysis, before);
  assert.equal(savedStructureRange(analysis, analysis.scopes![0]!), analysis.scopes![0]);
});

test('partial overlap, other video, duplicate versions and private candidates never redirect the entry', () => {
  for (const change of [
    (a: ProductAnalysis) => { a.scopes![0]!.startMs++; },
    (a: ProductAnalysis) => { a.scopes![0]!.sourceId = 'other'; },
    (a: ProductAnalysis) => { delete a.intervals[0]!.savedResultScopeId; },
    (a: ProductAnalysis) => { a.candidates.push({ ...a.intervals[0]!, id: 'private', intervalId: 'lecture', text: '个人修改', tags: ['卖点'], origin: 'manual', version: 1 }); },
  ]) {
    const analysis = seed(); change(analysis);
    assert.equal(savedStructureRange(analysis, analysis.intervals[0]!), analysis.intervals[0]);
  }
});

test('restored speech tags and joined leaf candidates appear under the same normal product as saved plans', () => {
  const analysis = seed();
  analysis.products[1]!.name = '已有拼结构 4141–5173秒';
  analysis.scopes!.push(...['first', 'second'].map((id, index) => ({ id, productId: 'saved', sourceId: 's',
    startMs: index ? 4600000 : 4141200, endMs: index ? 5172760 : 4600000,
    kind: 'historical-analysis' as const, confirmed: true as const, origin: 'shared-historical' })));
  analysis.candidates = ['first', 'second'].map((intervalId, index) => ({ id: `original-${index}`, sourceId: 's', productId: 'saved', intervalId,
    startMs: index ? 4600000 : 4141200, endMs: index ? 4601000 : 4142200, text: '原始话术', tags: [index ? '卖点' : '钩子'], origin: 'ai-text', version: 1 }));
  const before = structuredClone(analysis);
  assert.deepEqual(productResultCandidates(analysis, 'jacket').map(c => c.id), ['original-0', 'original-1']);
  assert.deepEqual(productResultCandidates(analysis, 'jacket').map(c => c.tags), [['钩子'], ['卖点']]);
  assert.deepEqual(visibleProducts(analysis).map(p => p.id), ['jacket']);
  assert.deepEqual(analysis, before, 'presentation cannot rewrite original ownership, IDs or tags');
  analysis.products[1]!.name = '用户自己起的名字';
  assert.deepEqual(visibleProducts(analysis).map(p => p.id), ['jacket', 'saved']);
});

test('unmatched recovery cards remain available and personal candidates prevent substitution', () => {
  const analysis = seed();
  analysis.products[1]!.name = '已有拼结构 4141–5173秒';
  analysis.scopes![0]!.startMs++;
  assert.deepEqual(visibleProducts(analysis).map(p => p.id), ['jacket', 'saved']);
  analysis.scopes![0]!.startMs--;
  analysis.candidates.push({ ...analysis.intervals[0]!, id: 'private', intervalId: 'lecture', text: '手工话术', tags: ['卖点'], origin: 'manual', version: 1 });
  assert.deepEqual(visibleProducts(analysis).map(p => p.id), ['jacket', 'saved']);
  assert.deepEqual(productResultCandidates(analysis, 'jacket').map(c => c.id), ['private']);
});
