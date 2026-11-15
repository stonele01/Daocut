import test from 'node:test';
import assert from 'node:assert/strict';
import { planNleTimeline } from './nle.mjs';
import { jianyingDraft } from './jianying.mjs';

const facts = { w: 912, h: 1920, duration: 20, hasVideo: true, hasAudio: true };
const picture = { id: 'cut', kind: 'video', src: 'a.mp4', path: '/a.mp4', at: 0, end: 2, from: 1.123, speed: 1.3, track: 0, hidden: false, facts };
const sound = { id: 'cut', src: 'a.mp4', path: '/a.mp4', at: 0, from: 1.123, to: 3.723, speed: 1.3, volume: 0.7, enabled: true, role: 'footage', picture: 'cut', facts };
const opts = { title: 'native', fps: 30, audio: 'clips', media: 'link', mediaDir: '/draft/media', nativeSpeed: true };
const make = (pictures = [picture], sounds = [sound], options = {}) => planNleTimeline({ stage: { w: 912, h: 1920 }, duration: 2, pictures, sounds }, { ...opts, ...options });

test('native draft preserves exact source cuts, speed, audio gain and material reuse', () => {
  const plan = make();
  assert.equal(plan.files.length, 1);
  assert.equal(plan.files[0].job.kind, 'link');
  const { info } = jianyingDraft(plan, { name: 'test', folder: '/draft', root: '/' });
  const clips = info.tracks.flatMap(t => t.segments);
  assert.equal(clips.length, 1);
  assert.deepEqual(clips[0].source_timerange, { start: 1123000, duration: 2600000 });
  assert.deepEqual(clips[0].target_timerange, { start: 0, duration: 2000000 });
  assert.equal(clips[0].speed, 1.3);
  assert.equal(clips[0].volume, 0.7);
  assert.equal(info.materials.speeds[0].speed, 1.3);
});

test('independent audio uses its own native speed, with muted original sound kept silent', () => {
  const plan = make([picture], [{ ...sound, enabled: false }, { ...sound, id: 'voice', picture: undefined, src: 'voice.wav', path: '/voice.wav', speed: 0.65, facts: { duration: 20, hasAudio: true } }]);
  const { info } = jianyingDraft(plan, { name: 'test', folder: '/draft', root: '/' });
  assert.equal(info.tracks.find(t => t.type === 'video').segments[0].volume, 0);
  const voice = info.tracks.find(t => t.type === 'audio').segments[0];
  assert.equal(voice.speed, 0.65);
  assert.equal(voice.target_timerange.duration, 4000000);
  assert.ok(plan.files.every(f => f.job.kind === 'link'));
});

test('effects still render, faded audio stays separate, XML retains its prior baking behavior', () => {
  assert.ok(make([{ ...picture, styled: true }]).files.some(f => f.job.kind === 'render'));
  const faded = make([picture], [{ ...sound, fade: [0.2, 0] }]);
  assert.ok(faded.files.some(f => f.job.kind === 'transcode'));
  const info = jianyingDraft(faded, { name: 'test', folder: '/draft', root: '/' }).info;
  assert.equal(info.tracks.find(t => t.type === 'video').segments[0].volume, 0);
  assert.equal(info.tracks.find(t => t.type === 'audio').segments[0].speed, 1);
  const legacy = make([picture], [sound], { nativeSpeed: false });
  assert.deepEqual(legacy.files.map(f => f.job.kind), ['render', 'transcode']);
});

test('many native cuts remain contiguous on the target frame grid without cumulative drift', () => {
  const durations = [1.037, 1.913, 0.829, 2.101, 1.041];
  let at = 0;
  const pictures = durations.map((duration, i) => {
    const cut = { ...picture, id: `cut-${i}`, at, end: at + duration / 1.3, from: i * 2 };
    at = cut.end; return cut;
  });
  const clips = make(pictures, []).video[0].clips;
  for (let i = 1; i < clips.length; i++) assert.equal(clips[i].start, clips[i - 1].end);
  assert.equal(clips.at(-1).end, Math.round(at * 30));
});
