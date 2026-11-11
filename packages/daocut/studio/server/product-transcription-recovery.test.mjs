import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import * as transcription from './product-transcription.mjs';
import { doubaoResult } from './providers/doubao.mjs';
import { createLiveAnalysis } from './live-analysis.mjs';

const base = fileURLToPath(new URL('../../../../.tmp/asr-boundary-20261110/tests/', import.meta.url));
const requestId = '11111111-1111-4111-8111-111111111111';
const body = (end = 2010) => ({ audio_info: { duration: 2096 }, result: { text: '模拟完整原话。', utterances: [
  { text: '模拟完整原话。', start_time: 100, end_time: end, words: [{ text: '模拟完整原话', start_time: 100, end_time: end }] },
] } });
async function fixture(t) {
  await mkdir(base, { recursive: true }); const root = await mkdtemp(join(base, 'case-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.mock.method(globalThis, 'fetch', () => { throw Error('network forbidden'); });
  await mkdir(join(root, 'assets')); await writeFile(join(root, 'assets/live.mp4'), 'synthetic');
  await writeFile(join(root, 'film.html'), 'personal film stays');
  const source = { id: 'source', assetPath: 'assets/live.mp4', durationMs: 2000 };
  const loc = await transcription.transcriptionLocation(root, source);
  const pending = { version: 1, status: 'pending', sourceId: source.id, assetPath: source.assetPath, durationMs: 2000, fingerprint: loc.fingerprint, requestId,
    attempts: [{ requestId, status: 'submitted', startedAt: '2026-11-10T10:13:52.000Z' }] };
  const raw = { provider: 'doubao', model: 'volc.bigasr.auc_turbo', requestId, httpStatus: 200, serviceStatus: '20000000', sourceId: source.id, assetPath: source.assetPath, sourceFingerprint: loc.fingerprint, body: body() };
  const rawPath = join(loc.dir, 'raw-responses', `${requestId}.json`);
  const seed = async () => { await mkdir(join(loc.dir, 'raw-responses'), { recursive: true }); await writeFile(loc.path, JSON.stringify(pending)); await writeFile(rawPath, JSON.stringify(raw)); };
  return { root, source, loc, pending, raw, rawPath, seed };
}

test('a 10ms ASR tail overrun is bounded to the video; original words and text remain', async t => {
  const f = await fixture(t); let requests = 0;
  const original = body();
  const result = await transcription.transcribeProductSource(f.root, f.source, {
    getKey: async () => 'mock', readAudio: async () => Buffer.from('synthetic audio'),
    runProvider: async () => { requests++; return { index: [doubaoResult(original, '20000000')] }; },
  });
  assert.equal(requests, 1); assert.equal(result.text, original.result.text);
  assert.equal(result.cues[0].endMs, 2000); assert.equal(result.words[0].endMs, 2000);
  assert.equal(result.rawWords[0].end_time, 2010);
  const saved = JSON.parse(await readFile(f.loc.path, 'utf8'));
  assert.equal(saved.timingAdjustments.length, 2);
  assert.deepEqual((await transcription.readProductTranscript(f.root, f.source)).cues, result.cues);
});

test('material overruns and words starting after the video are not silently clipped', async t => {
  for (const end of [2151, 3000]) {
    const f = await fixture(t);
    await assert.rejects(transcription.transcribeProductSource(f.root, f.source, { getKey: async () => 'mock', readAudio: async () => Buffer.from('audio'), runProvider: async () => ({ index: [{ text: '模拟', words: [{ token: '模拟', start: .1, end: end / 1000 }], cues: [{ text: '模拟', startMs: 100, endMs: end }] }] }) }), /timestamp|时间/);
    assert.equal(JSON.parse(await readFile(f.loc.path, 'utf8')).status, 'pending');
  }
});

test('successful saved response is readable, then persisted without credentials, audio, or another request', async t => {
  const f = await fixture(t); await f.seed();
  const rawBefore = await readFile(f.rawPath, 'utf8'); const pendingBefore = await readFile(f.loc.path, 'utf8');
  const read = await transcription.readProductTranscript(f.root, f.source);
  assert.equal(read.cues[0].endMs, 2000); assert.equal(read.recoveredFromResponse, true);
  assert.equal(await readFile(f.loc.path, 'utf8'), pendingBefore, 'status lookup is read only');
  const forbidden = () => { throw Error('must reuse the saved reply'); };
  const result = await transcription.transcribeProductSource(f.root, f.source, { getKey: forbidden, readAudio: forbidden, runProvider: forbidden });
  assert.equal(result.cached, true);
  const reopened = await transcription.readProductTranscript(f.root, f.source);
  assert.deepEqual(reopened.cues, read.cues);
  const saved = JSON.parse(await readFile(f.loc.path, 'utf8'));
  assert.equal(saved.status, 'complete'); assert.equal(saved.attempts.length, 1); assert.equal(saved.requestId, requestId);
  assert.equal(saved.recovery.kind, 'saved-provider-response');
  assert.equal(await readFile(f.rawPath, 'utf8'), rawBefore);
  assert.equal(await readFile(join(f.root, 'film.html'), 'utf8'), 'personal film stays');
  assert.equal(await readFile(join(f.root, 'assets/live.mp4'), 'utf8'), 'synthetic');
});

test('failed live state recognizes a verified saved success instead of offering another upload', async t => {
  const f = await fixture(t); await f.seed();
  await writeFile(join(f.root, '.film/product-analysis.json'), JSON.stringify({ version: 1, sources: [f.source], products: [], intervals: [], candidates: [] }));
  const dir = join(f.root, '.film/live-analysis'); await mkdir(dir);
  await writeFile(join(dir, createHash('sha256').update(f.source.id).digest('hex') + '.json'), JSON.stringify({ version: 1, sourceId: f.source.id, transcription: { status: 'failed', error: 'old failure', retryBlocked: true }, analysis: { status: 'idle' }, analyses: {}, results: {}, attempts: {} }));
  const live = createLiveAnalysis({ probeSource: async () => ({ duration: 2 }) });
  const state = await live.view(f.root, f.source.id);
  assert.equal(state.transcription.status, 'complete'); assert.equal(state.transcription.error, undefined); assert.equal(state.transcription.retryBlocked, undefined);
});

test('mismatched, missing, and failed receipts never become successful transcripts', async t => {
  for (const change of [r => { r.requestId = '22222222-2222-4222-8222-222222222222'; }, r => { r.sourceFingerprint.size++; }, r => { r.sourceId = 'other'; }, r => { r.httpStatus = 403; }, r => { r.serviceStatus = 'failed'; }, r => { r.body.result.utterances = []; }]) {
    const f = await fixture(t); f.raw = structuredClone(f.raw); change(f.raw);
    await f.seed(); await writeFile(f.rawPath, JSON.stringify(f.raw));
    await assert.rejects(transcription.readProductTranscript(f.root, f.source));
    assert.equal(JSON.parse(await readFile(f.loc.path, 'utf8')).status, 'pending');
  }
});

test('offline recovery validates the saved identity and never overwrites an already complete personal transcript', async t => {
  const f = await fixture(t);
  assert.equal(typeof transcription.restoreProductTranscriptCache, 'function');
  const recovered = transcription.restoreProductTranscriptCache(f.pending, f.raw);
  assert.equal(recovered.cues[0].endMs, 2000); assert.equal(f.raw.body.result.utterances[0].end_time, 2010);
  const personal = { ...recovered, text: '个人修改', cues: [{ text: '个人修改', startMs: 100, endMs: 1000 }] };
  assert.throws(() => transcription.restoreProductTranscriptCache(personal, f.raw), /pending|待恢复/);
});
