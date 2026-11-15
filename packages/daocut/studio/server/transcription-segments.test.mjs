import test from 'node:test';
import assert from 'node:assert/strict';
import { planAudioSegments, mergeAudioSegments, mergeAudioTranscript, validateTranscriptCues } from './transcription-segments.mjs';

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

test('different overlap recognitions resolve once using the audio interior without mutating raw results', () => {
  const ranges = planAudioSegments(4000, { targetMs: 2000, overlapMs: 1000 });
  const segments = [
    { ...ranges[0], cues: [{ text: '不同规格甲', startMs: 1600, endMs: 2200 }] },
    { ...ranges[1], cues: [{ text: '不同规格乙', startMs: 300, endMs: 900 }] },
  ];
  const raw = structuredClone(segments);
  assert.deepEqual(mergeAudioSegments(segments, 4000), [{ text: '不同规格甲', startMs: 1600, endMs: 2200 }]);
  assert.deepEqual(segments, raw);
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
  for (const [a, b] of [['1.2升', '12升'], ['12%', '12']]) assert.deepEqual(mergeAudioSegments([
    { ...ranges[0], cues: [{ text: a, startMs: 1800, endMs: 2200 }] },
    { ...ranges[1], cues: [{ text: b, startMs: 300, endMs: 700 }] },
  ], 4000), [{ text: b, startMs: 1800, endMs: 2200 }]);
});

test('split sentences at an audio cut continue automatically and keep words from the chosen recognition', () => {
  const ranges = planAudioSegments(6000, { targetMs: 3000, overlapMs: 2000 });
  const result = mergeAudioTranscript([
    { ...ranges[0], cues: [{ text: '算下来每瓶四十二。', startMs: 2400, endMs: 2900 }, { text: '我手在抖因为', startMs: 3500, endMs: 3990 }], words: [{ token: '我手在抖因为', start: 3.5, end: 3.99 }] },
    { ...ranges[1], cues: [{ text: '算下来每瓶四十二。', startMs: 400, endMs: 900 }, { text: '我手在抖。', startMs: 1500, endMs: 1900 }, { text: '因为赔钱。', startMs: 1900, endMs: 2400 }], words: [{ token: '我手在抖', start: 1.5, end: 1.9 }, { token: '因为赔钱', start: 1.9, end: 2.4 }] },
  ], 6000);
  assert.deepEqual(result.cues.map(cue => cue.text), ['算下来每瓶四十二。', '我手在抖。', '因为赔钱。']);
  assert.deepEqual(result.words, [{ text: '我手在抖', startMs: 3500, endMs: 3900 }, { text: '因为赔钱', startMs: 3900, endMs: 4400 }]);
});

test('repetition at separate source times and words present on only one side are retained', () => {
  const ranges = planAudioSegments(4000, { targetMs: 2000, overlapMs: 1000 });
  assert.deepEqual(mergeAudioSegments([
    { ...ranges[0], cues: [{ text: '买一瓶', startMs: 1600, endMs: 1800 }] },
    { ...ranges[1], cues: [{ text: '买一瓶', startMs: 600, endMs: 800 }, { text: '再送一瓶', startMs: 850, endMs: 1100 }] },
  ], 4000).map(cue => cue.text), ['买一瓶', '买一瓶', '再送一瓶']);
});

test('invalid audio policy and out-of-source cues are rejected', () => {
  for (const duration of [-1, 0, NaN, Infinity]) assert.throws(() => planAudioSegments(duration));
  assert.throws(() => planAudioSegments(1000, { targetMs: 0 }));
  for (const cue of [{ startMs: -1, endMs: 1 }, { startMs: 1, endMs: 1 }, { startMs: 10, endMs: 2001 }]) assert.throws(() => validateTranscriptCues([{ text: 'a', ...cue }], 2000));
});
