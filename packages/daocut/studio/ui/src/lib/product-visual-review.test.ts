import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visualReviewPresentation, visualReviewCanSubmit, type ProductVisualReview, type ProductVisualPlan } from './product-visual-review.ts';

const review = (): ProductVisualReview => ({
  version: 'product-visual-review-v1', status: 'complete', scope: { startMs: 30000, endMs: 60000 },
  entries: [{ startMs: 35000, endMs: 42000, cueRange: [7, 8], productMatch: 'match', display: 'shown', evidenceTimesMs: [35123, 40000], observation: '抽帧中可见商品包装和瓶身', issues: [] }],
  issues: [], continuousActionVerified: false, speechVerified: false,
});

test('old results remain explicitly unreviewed and viewing never requests a model', t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('reading saved visual results must not call a model'));
  const view = visualReviewPresentation(undefined);
  assert.match(view.summary, /未保存/);
  assert.match(view.note, /未自动/);
  assert.deepEqual(view.entries, []);
});

test('saved AI observations preserve exact source evidence and their semantic limits', () => {
  const input = review(), before = JSON.stringify(input);
  const view = visualReviewPresentation(input, 'shared');
  assert.equal(view.summary, 'AI 看图结果已保存');
  assert.equal(view.range, '00:30–01:00');
  assert.equal(view.originLabel, '复用公共 AI 看图记录');
  assert.equal(view.entries[0]!.range, '00:35–00:42');
  assert.equal(view.entries[0]!.product, '商品对应：匹配');
  assert.equal(view.entries[0]!.display, '产品展示：画面可见');
  assert.equal(view.entries[0]!.evidence, '证据时刻：00:35.123、00:40');
  assert.equal(view.entries[0]!.observation, '抽帧中可见商品包装和瓶身');
  assert.match(view.note, /连续动作未核实/);
  assert.match(view.note, /原音未核听/);
  assert.equal(JSON.stringify(input), before);
});

test('uncertain, failed and unavailable results retain issues instead of asserting verification', () => {
  for (const status of ['uncertain', 'failed', 'unavailable'] as const) {
    const input = review(); input.status = status; input.issues = ['包装遮挡，需要核对'];
    input.entries[0]!.productMatch = 'uncertain'; input.entries[0]!.display = 'not-shown';
    input.entries[0]!.evidenceTimesMs = []; input.entries[0]!.issues = ['没有看清标签'];
    const view = visualReviewPresentation(input, 'local');
    assert.doesNotMatch(view.summary, /已保存$/);
    assert.equal(view.originLabel, '本机 AI 看图补查记录，未改公共底稿');
    assert.equal(view.entries[0]!.product, '商品对应：不确定');
    assert.equal(view.entries[0]!.display, '产品展示：抽帧未见');
    assert.equal(view.entries[0]!.evidence, '证据时刻：未提供');
    assert.deepEqual(view.issues, input.issues);
    assert.deepEqual(view.entries[0]!.issues, input.entries[0]!.issues);
  }
});

test('local unpublished and mismatch results are labelled without rewriting the observation', () => {
  const input = review(); input.entries[0]!.productMatch = 'mismatch'; input.entries[0]!.display = 'uncertain';
  const view = visualReviewPresentation(input, 'saved');
  assert.equal(view.originLabel, '当前工程已保存的 AI 看图记录');
  assert.equal(view.entries[0]!.product, '商品对应：不匹配');
  assert.equal(view.entries[0]!.display, '产品展示：不确定');
});

test('renamed product keeps old evidence explicitly historical instead of matching the current product', () => {
  const input = review(); input.productName = '原来的商品名';
  const view = visualReviewPresentation(input, 'shared', true);
  assert.equal(view.summary, 'AI 看图旧记录需核对');
  assert.match(view.note, /商品名称\/话术范围已变/);
  assert.equal(view.productName, '核查时商品：原来的商品名');
  assert.equal(view.entries[0]!.product, '旧记录商品对应：匹配');
});

test('paid visual retry requires an explicit acknowledgement and invalid plans cannot submit', () => {
  const plan: ProductVisualPlan = { identity: 'fixture', scope: { sourceId: 's', productId: 'p', intervalId: 'i', startMs: 30000, endMs: 60000 }, service: { enabled: true, name: '模拟看图', model: 'simulated' }, enabled: true, requestCount: 1, maxImages: 1, cached: false, retryRequired: true };
  assert.equal(visualReviewCanSubmit(plan, false), false);
  assert.equal(visualReviewCanSubmit(plan, true), true);
  assert.equal(visualReviewCanSubmit({ ...plan, error: '需核对' }, true), false);
  assert.equal(visualReviewCanSubmit({ ...plan, enabled: false }, true), false);
  assert.equal(visualReviewCanSubmit({ ...plan, enabled: false, cached: true, retryRequired: false, requestCount: 0 }, false), true);
  assert.equal(visualReviewCanSubmit({ ...plan, enabled: false, recoverable: true, retryRequired: false, requestCount: 0 }, false), true);
  assert.equal(visualReviewCanSubmit(undefined, true), false);
});
