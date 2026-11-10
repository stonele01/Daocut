import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { transcribeProductSource, readProductTranscript, confirmProductTranscript, confirmCachedProductTranscript } from './product-transcription.mjs';

async function fixture(t) {
  const base = resolve(import.meta.dirname, '../../../../.tmp/transcript-seams-20261104/backend');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'asr-segments-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'assets', 'source.mp4'), 'synthetic source remains unchanged');
  return { root, source: { id: 'source', assetPath: 'assets/source.mp4', durationMs: 4000 } };
}
const row = (text, startMs = 200) => ({ index: [{ text, words: [{ token: text, start: startMs / 1000, end: (startMs + 600) / 1000 }], cues: [{ text, startMs, endMs: startMs + 600 }] }] });
const options = { getKey: async () => 'isolated-test-key', audioPolicy: { targetMs: 2000, overlapMs: 1000 }, readAudio: async (_path, _signal, range) => Buffer.from(range.id) };

test('audio segment cache resumes only explicit failed request and preserves completed work', async t => {
  const { root, source } = await fixture(t);
  const calls = [];
  let fail = true;
  const runProvider = async (_verb, args, ctx) => {
    const id = (await ctx.read()).toString(); calls.push(id);
    assert.match(args.requestId, /^[a-f0-9-]{36}$/);
    if (id === 'audio-2' && fail) throw Error('uncertain');
    // These cache tests place independent speech outside the overlapping context.
    return row(id, id === 'audio-2' ? 1600 : 200);
  };
  await assert.rejects(transcribeProductSource(root, source, { ...options, runProvider }), /may have begun/);
  await assert.rejects(readProductTranscript(root, source), /may have been submitted/);
  await assert.rejects(transcribeProductSource(root, source, { ...options, runProvider }), /may have been submitted/);
  assert.deepEqual(calls, ['audio-1', 'audio-2']);
  fail = false;
  const value = await transcribeProductSource(root, source, { ...options, runProvider, retryUncertain: true });
  assert.deepEqual(calls, ['audio-1', 'audio-2', 'audio-2']);
  assert.deepEqual(value.cues.map(c => c.startMs), [200, 3100]);
  const reopened = await readProductTranscript(root, source);
  assert.deepEqual(reopened.cues, value.cues);
  await transcribeProductSource(root, source, { ...options, runProvider });
  assert.equal(calls.length, 3);
  const cachePath = join(root, '.film', 'product-transcripts', createHash('sha256').update(source.id).digest('hex') + '.json.segments.json');
  const manifestText = await readFile(cachePath, 'utf8');
  const manifest = JSON.parse(manifestText);
  assert.ok(manifest.segments.every(s => s.status === 'complete' && s.requestId));
  assert.equal(manifest.segments[1].attempts.length, 2);
  assert.ok(!manifestText.includes('isolated-test-key'));
  assert.equal(await readFile(join(root, source.assetPath), 'utf8'), 'synthetic source remains unchanged');
});

test('missing duration is probed and real local FFmpeg extracts each planned MP3 window', async t => {
  const { root, source } = await fixture(t);
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=32x32:r=5:d=4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest', '-y', join(root, source.assetPath)], { windowsHide: true });
  const durations = [];
  const result = await transcribeProductSource(root, { ...source, durationMs: null }, { getKey: options.getKey, audioPolicy: options.audioPolicy, runProvider: async (_verb, _args, ctx) => {
    const audio = join(root, `window-${durations.length}.mp3`);
    await writeFile(audio, await ctx.read());
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=sample_rate,channels', '-of', 'json', audio], { windowsHide: true, encoding: 'utf8' }));
    assert.equal(probe.streams[0].sample_rate, '16000'); assert.equal(probe.streams[0].channels, 1);
    durations.push(Number(probe.format.duration));
    return row(`window-${durations.length}`, durations.length === 2 ? 1600 : 200);
  } });
  assert.equal(durations.length, 2);
  assert.ok(durations.every(duration => duration >= 2.49 && duration < 2.7), JSON.stringify(durations));
  assert.deepEqual(result.cues.map(c => c.startMs), [200, 3100]);
});

test('legacy transcript is preserved until explicitly confirmed and never triggers a paid fallback', async t => {
  const { root, source } = await fixture(t);
  await transcribeProductSource(root, source, { ...options, runProvider: async (_verb, _args, ctx) => row('legacy', (await ctx.read()).toString() === 'audio-2' ? 1600 : 200) });
  const path = join(root, '.film', 'product-transcripts', createHash('sha256').update(source.id).digest('hex') + '.json');
  const previous = JSON.parse(await readFile(path, 'utf8'));
  delete previous.fingerprint.ctimeMs; delete previous.fingerprint.path;
  await writeFile(path, JSON.stringify(previous));
  await assert.rejects(readProductTranscript(root, source), /provenance/);
  await assert.rejects(transcribeProductSource(root, source, { ...options, runProvider: () => assert.fail('not authorized') }), /provenance/);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), previous);
  await confirmCachedProductTranscript(root, source, { sourceConfirmed: true });
  assert.equal((await readProductTranscript(root, source)).cached, true);
});

test('short source changed while the provider was running is never accepted as a complete transcript', async t => {
  const { root, source } = await fixture(t);
  await assert.rejects(transcribeProductSource(root, source, { getKey: options.getKey, readAudio: async () => Buffer.from('audio'), runProvider: async () => {
    await writeFile(join(root, source.assetPath), 'source changed while submitted');
    return row('stale');
  } }), /Source changed/);
  await assert.rejects(readProductTranscript(root, source), /may have been submitted/);
});

test('concurrent segmented requests deduplicate while invalid local times never become complete', async t => {
  const { root, source } = await fixture(t);
  let calls = 0;
  const runProvider = async (_verb, _args, ctx) => { calls++; return row('合成', (await ctx.read()).toString() === 'audio-2' ? 1600 : 200); };
  const [a, b] = await Promise.all([transcribeProductSource(root, source, { ...options, runProvider }), transcribeProductSource(root, source, { ...options, runProvider })]);
  assert.deepEqual(a, b); assert.equal(calls, 2);
  assert.equal((await readdir(join(root, 'assets'))).length, 1);
  await writeFile(join(root, source.assetPath), 'changed');
  await assert.rejects(transcribeProductSource(root, source, { ...options, runProvider: async () => ({ index: [{ ...row('bad').index[0], cues: [{ text: 'bad', startMs: 200, endMs: 9999 }] }] }) }), /sentence-level/);
  await assert.rejects(readProductTranscript(root, source), /may have been submitted/);
});

test('VTT binding rejects wrong duration, invalid times and changed transcript instead of silent reuse', async t => {
  const { root, source } = await fixture(t);
  const path = join(root, 'assets', 'source.vtt');
  await writeFile(path, 'WEBVTT\n\n00:00.500 --> 00:00.400\n倒置\n');
  await assert.rejects(confirmProductTranscript(root, source, { sourceConfirmed: true }), /invalid/);
  await writeFile(path, 'WEBVTT\n\n00:00.100 --> 00:01.000\n原句\n');
  await assert.rejects(confirmProductTranscript(root, source), /explicitly confirmed/);
  await confirmProductTranscript(root, source, { sourceConfirmed: true });
  const bindingPath = join(root, '.film', 'product-transcripts', createHash('sha256').update(source.id).digest('hex') + '.json.vtt-binding.json');
  const before = await readFile(bindingPath, 'utf8');
  await assert.rejects(confirmProductTranscript(root, source, { sourceConfirmed: true, durationMs: 2000 }), /does not match/);
  assert.equal(await readFile(bindingPath, 'utf8'), before);
  assert.equal((await readProductTranscript(root, source)).cues[0].text, '原句');
  await assert.rejects(readProductTranscript(root, { ...source, durationMs: 2000 }), /confirmation/);
  await writeFile(path, 'WEBVTT\n\n00:00.100 --> 00:01.000\n改句\n');
  await assert.rejects(transcribeProductSource(root, source, { ...options, runProvider: () => assert.fail('not authorized') }), /confirmation/);
});

test('word timestamps outside a short video cannot be accepted despite valid sentence cues', async t => {
  const { root, source } = await fixture(t);
  await assert.rejects(transcribeProductSource(root, source, { getKey: options.getKey, readAudio: async () => Buffer.from('audio'), runProvider: async () => {
    const result = row('bad word'); result.index[0].words[0].end = 100;
    return result;
  } }), /invalid timestamps/);
  await assert.rejects(readProductTranscript(root, source), /may have been submitted/);
});
