import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { transcribeProductSource, readProductTranscript, confirmProductTranscript } from './product-transcription.mjs';

test('synthetic transcription persists, deduplicates and never writes beside the source', async t => {
  const root = await mkdtemp(join(tmpdir(), 'product-asr-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'assets'));
  const file = join(root, 'assets', 'synthetic.mp4');
  await writeFile(file, 'synthetic');
  const source = { id: 'video-a', assetPath: 'assets/synthetic.mp4', durationMs: 2000 };
  let calls = 0, keys = 0;
  const options = { getKey: async () => { keys++; return 'secret-test-key'; }, readAudio: async () => Buffer.from('audio'), runProvider: async (_verb, _args, ctx) => { calls++; assert.equal(ctx.key, 'secret-test-key'); return { index: [{ text: '示例', words: [{ token: '示例', start: 0.2, end: 0.8 }], cues: [{ text: '示例', startMs: 200, endMs: 800 }] }] }; } };
  const [a, b] = await Promise.all([transcribeProductSource(root, source, options), transcribeProductSource(root, source, options)]);
  assert.deepEqual(a, b); assert.equal(calls, 1); assert.equal(keys, 1);
  assert.deepEqual(await readProductTranscript(root, source), { ...a, cached: true });
  assert.equal(await readFile(file, 'utf8'), 'synthetic');
  const cache = await readFile(join(root, '.film', 'product-transcripts', (await import('node:crypto')).createHash('sha256').update(source.id).digest('hex') + '.json'), 'utf8');
  assert.ok(!cache.includes('secret-test-key'));
  await writeFile(file, 'synthetic changed');
  assert.equal(await readProductTranscript(root, source), null);
  await transcribeProductSource(root, source, options);
  assert.equal(calls, 2);
});

test('uncertain submission survives reopen and requires explicit retry', async t => {
  const root = await mkdtemp(join(tmpdir(), 'product-asr-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'assets')); await writeFile(join(root, 'assets', 'a.mp4'), 'a');
  const source = { id: 'a', assetPath: 'assets/a.mp4', durationMs: 2000 };
  let calls = 0;
  const options = { getKey: async () => 'secret', readAudio: async () => Buffer.from('audio'), runProvider: async () => { calls++; throw Error('secret'); } };
  await assert.rejects(transcribeProductSource(root, source, options), /may have begun/);
  await assert.rejects(transcribeProductSource(root, source, options), /may have been submitted/);
  assert.equal(calls, 1);
  await assert.rejects(transcribeProductSource(root, source, { ...options, retryUncertain: true }), /may have begun/);
  assert.equal(calls, 2);
});

test('VTT requires explicit source confirmation, then reuses without network or rewriting subtitles', async t => {
  const root = await mkdtemp(join(tmpdir(), 'product-asr-vtt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'assets'));
  const media = join(root, 'assets', 'a.mp4');
  const vtt = join(root, 'assets', 'a.vtt');
  await writeFile(media, 'synthetic');
  const source = { id: 'a', assetPath: 'assets/a.mp4', durationMs: 2000 };
  assert.equal(await readProductTranscript(root, source), null);
  await assert.rejects(statMissing(join(root, '.film')), /ENOENT/);
  const content = 'WEBVTT\n\n00:00:00.500 --> 00:00:01.500\n虚构字幕\n';
  await writeFile(vtt, content);
  await assert.rejects(readProductTranscript(root, source), /explicit source/);
  await confirmProductTranscript(root, source, { sourceConfirmed: true, durationMs: 2000 });
  const result = await transcribeProductSource(root, source, { getKey: () => { throw Error('must not read key'); }, runProvider: () => { throw Error('must not call'); } });
  assert.deepEqual(result.words, []);
  assert.deepEqual(result.cues, [{ text: '虚构字幕', startMs: 500, endMs: 1500 }]);
  assert.equal(await readFile(vtt, 'utf8'), content);
  await writeFile(media, 'changed synthetic media');
  const { utimes } = await import('node:fs/promises');
  await utimes(media, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  assert.equal(await readProductTranscript(root, source), null);
});
async function statMissing(path) { const { stat } = await import('node:fs/promises'); return stat(path); }

test('mock Doubao preserves sentence text and actual timings, even when tokens differ', async t => {
  const { default: doubao } = await import('./providers/doubao.mjs');
  const root = await mkdtemp(join(tmpdir(), 'product-asr-cues-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'assets')); await writeFile(join(root, 'assets', 'a.mp4'), 'synthetic');
  const body = { audio_info: { duration: 2000 }, result: { text: '增长20%，真好。', utterances: [
    { text: '增长20%，', start_time: 100, end_time: 900, words: [{ text: '增长百分之二十', start_time: 100, end_time: 850 }] },
    { text: '真好。', start_time: 1000, end_time: 1500, words: [{ text: '真好', start_time: 1000, end_time: 1450 }] },
  ] } };
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, headers: new Headers({ 'X-Api-Status-Code': '20000000' }), json: async () => body });
  t.after(() => { globalThis.fetch = oldFetch; });
  const source = { id: 'a', assetPath: 'assets/a.mp4', durationMs: 2000 };
  const options = { getKey: async () => 'synthetic-key', readAudio: async () => Buffer.from('audio'), runProvider: doubao.run.bind(doubao) };
  const result = await transcribeProductSource(root, source, options);
  assert.equal(result.text, '增长20%，真好。');
  assert.deepEqual(result.cues, [{ text: '增长20%，', startMs: 100, endMs: 900 }, { text: '真好。', startMs: 1000, endMs: 1500 }]);
  assert.deepEqual(result.rawWords, body.result.utterances.flatMap(line => line.words));
  assert.equal((await readProductTranscript(root, source)).cues[0].text, '增长20%，');
});

test('missing sentence time and legacy word-only cache do not fabricate sentence timing', async t => {
  const { default: doubao } = await import('./providers/doubao.mjs');
  const { createHash } = await import('node:crypto');
  const { stat } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'product-asr-no-cues-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'assets')); const file = join(root, 'assets', 'a.mp4'); await writeFile(file, 'synthetic');
  const source = { id: 'a', assetPath: 'assets/a.mp4', durationMs: 2000 };
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, headers: new Headers({ 'X-Api-Status-Code': '20000000' }), json: async () => ({ result: { text: '20元。', utterances: [{ text: '20元。', words: [{ text: '二十元', start_time: 100, end_time: 800 }] }] } }) });
  t.after(() => { globalThis.fetch = oldFetch; });
  await assert.rejects(transcribeProductSource(root, source, { getKey: async () => 'synthetic-key', readAudio: async () => Buffer.from('audio'), runProvider: doubao.run.bind(doubao) }), /sentence-level location is unavailable/);
  await assert.rejects(transcribeProductSource(root, source, { getKey: async () => 'synthetic-key' }), /may have been submitted/);
  const info = await stat(file);
  const path = join(root, '.film', 'product-transcripts', createHash('sha256').update(source.id).digest('hex') + '.json');
  await writeFile(path, JSON.stringify({ version: 1, status: 'complete', sourceId: source.id, assetPath: source.assetPath, fingerprint: { size: info.size, mtimeMs: info.mtimeMs }, text: '20元。', words: [{ text: '二十元', startMs: 100, endMs: 800 }] }));
  await assert.rejects(readProductTranscript(root, source), /sentence-level location is unavailable/);
  await assert.rejects(transcribeProductSource(root, source, { getKey: async () => { throw Error('must not upload'); } }), /sentence-level location is unavailable/);
});
