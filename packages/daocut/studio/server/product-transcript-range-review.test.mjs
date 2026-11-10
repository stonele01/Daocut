import test from 'node:test';
import assert from 'node:assert/strict';
import { productTranscriptRange } from './product-transcript-range.mjs';

const transcript = () => ({
  cues: [{ startMs: 1000, endMs: 3000, text: '用户确认的完整新句。' }, { startMs: 4000, endMs: 6000, text: '未改动的下一句。' }],
  words: [{ startMs: 1000, endMs: 1800, text: '错误' }, { startMs: 1800, endMs: 2800, text: '旧词' }, { startMs: 4000, endMs: 4800, text: '下一句' }, { startMs: 4800, endMs: 5800, text: '原词' }],
  unalignedRanges: [{ startMs: 1000, endMs: 3000 }],
});

test('manual seam text never falls back to old word content when a product boundary cuts the edited cue', () => {
  assert.throws(() => productTranscriptRange(transcript(), { startMs: 1500, endMs: 3000 }, 10000), error => error.status === 409 && /人工|修订/.test(error.message));
});

test('whole manual sentence is usable and unchanged sentences retain reliable word trimming', () => {
  assert.deepEqual(productTranscriptRange(transcript(), { startMs: 1000, endMs: 3000 }, 10000).segments,
    [{ startMs: 1000, endMs: 3000, text: '用户确认的完整新句。' }]);
  assert.deepEqual(productTranscriptRange(transcript(), { startMs: 4500, endMs: 6000 }, 10000).segments,
    [{ startMs: 4800, endMs: 5800, text: '原词' }]);
});

test('the guard applies to a partially overlapping edited interval, not just exact matching times', () => {
  const value = transcript(); value.unalignedRanges = [{ startMs: 1700, endMs: 2000 }];
  assert.throws(() => productTranscriptRange(value, { startMs: 1000, endMs: 1900 }, 10000), { status: 409 });
  value.unalignedRanges = [];
  assert.equal(productTranscriptRange(value, { startMs: 1000, endMs: 1900 }, 10000).segments[0].text, '错误');
});
