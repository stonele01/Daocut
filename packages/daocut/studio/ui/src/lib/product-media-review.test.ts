import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mediaReviewPresentation, type ProductMediaReview } from './product-media-review.ts';

const review = (): ProductMediaReview => ({
  version: 'product-media-review-v1', key: 'isolated-review', status: 'complete',
  scope: { startMs: 30210, endMs: 49920 },
  segments: [{ startMs: 30210, endMs: 49920, cueRange: [12, 15],
    visual: { status: 'sampled', sampleTimesMs: [30210, 35000, 40000] },
    audio: { status: 'technical-checked', hasAudio: true, peakDb: 0, integratedLufs: -18.2 }, issues: [] }],
  issues: [], speechVerified: false, continuousActionVerified: false,
});

test('old analysis without media evidence remains visibly unreviewed', () => {
  const view = mediaReviewPresentation(undefined);
  assert.match(view.summary, /未保存记录/);
  assert.match(view.note, /未自动补查/);
  assert.deepEqual(view.segments, []);
});

test('saved sampled frames and audio metrics retain exact source ranges without claiming semantic review', () => {
  const input = review(), before = JSON.stringify(input);
  const view = mediaReviewPresentation(input);
  assert.equal(view.summary, '音画工具结果已保存');
  assert.equal(view.range, '00:30.210–00:49.920');
  assert.equal(view.segments[0]?.range, '00:30.210–00:49.920');
  assert.match(view.segments[0]!.visual, /3 个时刻/);
  assert.match(view.segments[0]!.visual, /00:30.210/);
  assert.match(view.segments[0]!.audio, /峰值 0 dB/);
  assert.match(view.segments[0]!.audio, /-18.2 LUFS/);
  assert.match(view.note, /连续动作未核实/);
  assert.match(view.note, /原音未核听/);
  assert.equal(JSON.stringify(input), before);
});

test('partial failure exposes saved tool issues without relabelling completion', () => {
  const input = review();
  input.status = 'failed';
  input.issues = ['音频处理失败，已有画面保留'];
  input.segments[0]!.audio = { status: 'unavailable' };
  input.segments[0]!.issues = ['未读取本段音轨'];
  const view = mediaReviewPresentation(input);
  assert.equal(view.summary, '音画工具检查未完成');
  assert.deepEqual(view.issues, ['音频处理失败，已有画面保留']);
  assert.deepEqual(view.segments[0]!.issues, ['未读取本段音轨']);
  assert.equal(view.segments[0]!.audio, '音频技术检查：未完成');
  assert.match(view.segments[0]!.visual, /3 个时刻/);
});

test('missing audio and unavailable visuals do not invent zeros or completed checks', () => {
  const input = review();
  input.segments[0]!.visual = { status: 'unavailable', sampleTimesMs: [] };
  input.segments[0]!.audio = { status: 'technical-checked', hasAudio: false };
  const view = mediaReviewPresentation(input);
  assert.equal(view.segments[0]!.visual, '画面：未取得抽帧');
  assert.equal(view.segments[0]!.audio, '音频技术检查：测量范围未记录 · 未检出音轨');
  assert.doesNotMatch(view.segments[0]!.audio, /0 dB|0 LUFS/);
});

test('two scopes remain distinct and summary rendering performs no requests', t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('display cannot request a model or rerun analysis'));
  const first = review(), returning = review();
  returning.scope = { startMs: 56000, endMs: 70000 };
  returning.segments = [{ startMs: 56000, endMs: 62000, cueRange: [16, 17],
    visual: { status: 'sampled', sampleTimesMs: [56000, 60000] }, audio: { status: 'unavailable' }, issues: [] }];
  assert.equal(mediaReviewPresentation(first).range, '00:30.210–00:49.920');
  const view = mediaReviewPresentation(returning);
  assert.equal(view.range, '00:56–01:10');
  assert.equal(view.segments[0]?.range, '00:56–01:02');
  assert.doesNotMatch(JSON.stringify(view), /00:30|00:49/);
});

test('local supplementary checks never present themselves as a changed public baseline', () => {
  const local = mediaReviewPresentation(review(), 'local');
  assert.equal(local.originLabel, '本机补查记录，未改公共底稿');
  assert.equal(local.rangeLabel, '本机检查范围');
  const shared = mediaReviewPresentation(review(), 'shared');
  assert.equal(shared.originLabel, '复用公共音画记录');
  assert.equal(shared.rangeLabel, '公共记录范围');
  assert.equal(mediaReviewPresentation(review()).originLabel, shared.originLabel);
  assert.equal(mediaReviewPresentation(undefined, 'local').originLabel, '');
});

test('audio metrics identify whole-lecture measurement instead of claiming each candidate was measured', () => {
  const input = review();
  input.scope = { startMs: 0, endMs: 60000 };
  input.segments[0]!.audio.measurementRange = { startMs: 0, endMs: 60000 };
  const segment = mediaReviewPresentation(input).segments[0]!;
  assert.equal(segment.range, '00:30.210–00:49.920');
  assert.match(segment.audio, /本次讲解整体测量（00:00–01:00）/);
  assert.match(segment.audio, /峰值 0 dB/);
  assert.doesNotMatch(segment.audio, /00:30.210–00:49.920/);
  delete input.segments[0]!.audio.measurementRange;
  assert.match(mediaReviewPresentation(input).segments[0]!.audio, /测量范围未记录/);
  assert.doesNotMatch(mediaReviewPresentation(input).segments[0]!.audio, /00:00–01:00/);
});

test('unpublished analysis and failed records do not claim public reuse', () => {
  const input = review();
  delete input.key;
  input.status = 'failed';
  input.segments = [];
  const view = mediaReviewPresentation(input, 'saved');
  assert.equal(view.originLabel, '当前工程已保存的音画记录');
  assert.equal(view.rangeLabel, '原片范围');
  assert.doesNotMatch(view.originLabel, /公共|复用/);
  assert.equal(view.summary, '音画工具检查未完成');
});
