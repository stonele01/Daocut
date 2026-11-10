import test from 'node:test';
import assert from 'node:assert/strict';
import { planAudioSegments, mergeAudioSegments, validateTranscriptCues } from './transcription-segments.mjs';

test('23 minute source uses two audio windows and ten seconds of shared boundary context', () => {
  const ranges = planAudioSegments(1404879);
  assert.equal(ranges.length, 2);
  assert.deepEqual(ranges.map(r => [r.startMs, r.endMs]), [[0, 1205000], [1195000, 1404879]]);
  assert.equal(ranges[0].endMs - ranges[1].startMs, 10000);
  assert.equal(planAudioSegments(4 * 3600000).length, 12);
});

test('audio offsets restore source time without joining the intervening product', () => {
  const ranges = planAudioSegments(4000, { targetMs: 2000, overlapMs: 1000 });
  const cues = mergeAudioSegments([
    { ...ranges[0], cues: [{ text: 'A', startMs: 100, endMs: 900 }, { text: 'B', startMs: 1800, endMs: 2200 }] },
    { ...ranges[1], cues: [{ text: 'B', startMs: 300, endMs: 700 }, { text: 'A返场', startMs: 1600, endMs: 2300 }] },
  ], 4000);
  assert.deepEqual(cues, [{ text: 'A', startMs: 100, endMs: 900 }, { text: 'B', startMs: 1800, endMs: 2200 }, { text: 'A返场', startMs: 3100, endMs: 3800 }]);
});

test('incompatible overlap is a review issue, never a silent transcript overwrite', () => {
  const ranges = planAudioSegments(4000, { targetMs: 2000, overlapMs: 1000 });
  assert.throws(() => mergeAudioSegments([
    { ...ranges[0], cues: [{ text: '不同规格甲', startMs: 1600, endMs: 2200 }] },
    { ...ranges[1], cues: [{ text: '不同规格乙', startMs: 300, endMs: 900 }] },
  ], 4000), error => error.code === 'ASR_BOUNDARY_REVIEW');
});

test('timestamp drift cannot make both windows drop the same boundary utterance', () => {
  const ranges = planAudioSegments(4000, { targetMs: 2000, overlapMs: 1000 });
  const cues = mergeAudioSegments([
    { ...ranges[0], cues: [{ text: '前文', startMs: 100, endMs: 900 }, { text: '边界商品', startMs: 1800, endMs: 2250 }] },
    { ...ranges[1], cues: [{ text: '边界商品', startMs: 200, endMs: 700 }, { text: '后文', startMs: 1600, endMs: 2300 }] },
  ], 4000);
  assert.deepEqual(cues.map(c => c.text), ['前文', '边界商品', '后文']);
});

test('decimal points and percentages remain meaningful when comparing overlap transcripts', () => {
  const ranges = planAudioSegments(4000, { targetMs: 2000, overlapMs: 1000 });
  for (const [a, b] of [['1.2升', '12升'], ['12%', '12']]) assert.throws(() => mergeAudioSegments([
    { ...ranges[0], cues: [{ text: a, startMs: 1800, endMs: 2200 }] },
    { ...ranges[1], cues: [{ text: b, startMs: 300, endMs: 700 }] },
  ], 4000), error => error.code === 'ASR_BOUNDARY_REVIEW');
});

test('invalid audio policy and out-of-source cues are rejected', () => {
  for (const duration of [-1, 0, NaN, Infinity]) assert.throws(() => planAudioSegments(duration));
  assert.throws(() => planAudioSegments(1000, { targetMs: 0 }));
  for (const cue of [{ startMs: -1, endMs: 1 }, { startMs: 1, endMs: 1 }, { startMs: 10, endMs: 2001 }]) assert.throws(() => validateTranscriptCues([{ text: 'a', ...cue }], 2000));
});
