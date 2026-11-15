import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { inspectAudioSeams, resolveAudioSeams } from './transcription-seams.mjs';
import { planAudioSegments } from './transcription-segments.mjs';
import { transcribeProductSource, readProductTranscript } from './product-transcription.mjs';
import { readTranscriptReview, saveTranscriptReview } from './transcript-review.mjs';
import { updateProductAnalysis } from './product-analysis.mjs';
import { createLiveAnalysis } from './live-analysis.mjs';

const ranges = planAudioSegments(6000, { targetMs: 2000, overlapMs: 1000 });
const cue = (text, startMs, endMs) => ({ text, startMs, endMs });
const segments = () => [
  { ...ranges[0], cues: [cue('前文', 100, 800), cue('前段截断因为', 1800, 2490)] },
  { ...ranges[1], cues: [cue('前段截断', 300, 700), cue('因为完整内容', 700, 1300), cue('规格甲', 2300, 2900)] },
  { ...ranges[2], cues: [cue('规格乙', 300, 900), cue('后文', 1500, 2000)] },
];

test('automatic seams retain both original sides and absolute offsets, including one-to-many sentences', () => {
  const input = segments(), before = JSON.stringify(input);
  const result = inspectAudioSeams(input, 6000);
  assert.equal(result.seams.length, 2); assert.equal(result.pendingCount, 0);
  assert.deepEqual(result.seams[0].right.slice(0, 2).map(c => [c.startMs, c.endMs]), [[1800, 2200], [2200, 2800]]);
  assert.equal(result.seams[0].left[0].text, '前段截断因为');
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(resolveAudioSeams(result, {}).map(cue => cue.text), ['前文', '前段截断', '因为完整内容', '规格乙', '后文']);
});

test('exact overlapping duplicate is automatic but normal repeated speech outside overlap is retained', () => {
  const input = [
    { ...ranges[0], cues: [cue('再说一次', 100, 500), cue('相同价格12%', 1800, 2200)] },
    { ...ranges[1], cues: [cue('相同价格12%', 300, 700), cue('再说一次', 1300, 1800)] },
  ];
  const result = inspectAudioSeams(input, 4500);
  assert.equal(result.pendingCount, 0); assert.equal(result.seams[0].status, 'automatic');
  assert.deepEqual(resolveAudioSeams(result, {}).map(c => c.text), ['再说一次', '相同价格12%', '再说一次']);
});

test('nearby repeated text and numeric differences do not interrupt automatic preparation', () => {
  for (const [left, right] of [
    [cue('同一句', 1700, 1900), cue('同一句', 450, 700)],
    [cue('1.2升12%', 1800, 2200), cue('12升12', 300, 700)],
  ]) {
    const result = inspectAudioSeams([{ ...ranges[0], cues: [left] }, { ...ranges[1], cues: [right] }], 4500);
    assert.equal(result.pendingCount, 0);
  }
});

test('a tiny timestamp intersection cannot silently remove genuinely repeated short text', () => {
  const input = [
    { ...ranges[0], cues: [cue('对', 1700, 2000)] },
    { ...ranges[1], cues: [cue('对', 499, 800)] },
  ];
  const result = inspectAudioSeams(input, 4500);
  assert.equal(result.pendingCount, 0); assert.equal(result.seams[0].left.length, 1); assert.equal(result.seams[0].right.length, 1);
  assert.equal(resolveAudioSeams(result, {}).length, 2);
});

test('a complete sentence may cross the core cut and manual resolutions cannot escape their seam or invent invalid time', () => {
  const result = inspectAudioSeams(segments(), 6000), seam = result.seams[0];
  const complete = cue('人工听原片确认的一句', 1800, 2800);
  const resolutions = Object.fromEntries(result.seams.map(s => [s.id, s.right])); resolutions[seam.id] = [complete];
  assert.deepEqual(resolveAudioSeams(result, resolutions).find(c => c.text === complete.text), complete);
  for (const invalid of [cue('bad', -1, 2000), cue('bad', 2000, 1900), cue('bad', 1800, 6001), cue('', 1800, 2200), cue('out of seam', 0, 100)]) {
    assert.throws(() => resolveAudioSeams(result, { ...resolutions, [seam.id]: [invalid] }));
  }
});

async function fixture(t) {
  const base = resolve(import.meta.dirname, '../../../../.tmp/transcript-seams-20261104/backend');
  await mkdir(base, { recursive: true }); const root = await mkdtemp(join(base, 'case-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.mock.method(globalThis, 'fetch', () => { throw Error('real network prohibited'); });
  await mkdir(join(root, 'assets')); await writeFile(join(root, 'assets/live.mp4'), 'synthetic-original'); await writeFile(join(root, 'film.html'), 'protected-film');
  const source = { id: 'source', assetPath: 'assets/live.mp4', durationMs: 6000 };
  const probe = async () => ({ duration: 6 });
  await updateProductAnalysis(root, data => ({ ...data, sources: [source], products: [{ id: 'p', name: '人工名称', sourceIds: ['source'] }], intervals: [{ id: 'r', sourceId: 'source', productId: 'p', startMs: 100, endMs: 5500 }] }), probe);
  let calls = 0;
  const options = { getKey: async () => 'fake', audioPolicy: { targetMs: 2000, overlapMs: 1000 }, readAudio: async (_p, _s, range) => Buffer.from(range.id), runProvider: async (_v, args, ctx) => {
    const segment = segments()[calls++];
    const row = { text: segment.cues.map(c => c.text).join(''), cues: segment.cues, words: segment.cues.map(c => ({ token: c.text, start: c.startMs / 1000, end: c.endMs / 1000 })) };
    await ctx.onResponse?.({ provider: 'doubao', requestId: args.requestId, httpStatus: 200, serviceStatus: '20000000', body: { result: row } });
    return { index: [row] };
  } };
  assert.ok((await transcribeProductSource(root, source, options)).cues.length);
  const cache = join(root, '.film/product-transcripts', createHash('sha256').update(source.id).digest('hex') + '.json');
  const raw = await readFile(cache + '.segments.json', 'utf8');
  return { root, source, cache, raw, options, probe, calls: () => calls };
}
const save = (f, state, seam, cues = seam.right, extra = {}) => saveTranscriptReview(f.root, { sourceId: f.source.id, identity: state.identity, expectedRevision: state.revision, seamId: seam.id, cues, confirmed: true, acknowledgeImpact: true, ...extra });

test('per-seam confirmation survives reopen and produces source-absolute reviewed transcript without provider calls', async t => {
  const f = await fixture(t); const before = await readFile(join(f.root, '.film/product-analysis.json'), 'utf8');
  let state = await readTranscriptReview(f.root, f.source.id);
  assert.equal(state.pendingCount, 0); assert.equal(state.impact.ranges[0].productName, '人工名称');
  assert.ok((await readProductTranscript(f.root, f.source)).cues.length);
  state = await save(f, state, state.seams[0]); assert.equal(state.pendingCount, 0);
  assert.equal((await readProductTranscript(f.root, f.source)).localReconciled, true);
  state = await readTranscriptReview(f.root, f.source.id); assert.equal(state.revision, 1);
  state = await save(f, state, state.seams[1]); assert.equal(state.pendingCount, 0);
  const transcript = await readProductTranscript(f.root, f.source);
  assert.ok(transcript.cues.some(c => c.text === '因为完整内容' && c.startMs === 2200));
  assert.equal(transcript.unalignedRanges.length, 2);
  await transcribeProductSource(f.root, f.source, f.options); assert.equal(f.calls(), 3);
  assert.equal(await readFile(f.cache + '.segments.json', 'utf8'), f.raw);
  assert.equal(await readFile(join(f.root, '.film/product-analysis.json'), 'utf8'), before);
  assert.equal(await readFile(join(f.root, 'film.html'), 'utf8'), 'protected-film');
});

test('duplicate save is idempotent, stale conflicting writers are refused, and edits preserve earlier confirmations', async t => {
  const f = await fixture(t), state = await readTranscriptReview(f.root, f.source.id), seam = state.seams[0];
  const [a, b] = await Promise.all([save(f, state, seam), save(f, state, seam)]);
  assert.equal(a.revision, 1); assert.equal(b.revision, 1);
  await assert.rejects(save(f, state, seam, [cue('另一个窗口', seam.startMs, seam.endMs)]), { status: 409 });
  const next = await save(f, a, seam, [cue('听原片修订', seam.startMs, seam.endMs)]);
  assert.equal(next.revision, 2); assert.equal(next.seams[0].resolved[0].text, '听原片修订');
  assert.equal(f.calls(), 3);
});

test('impact includes a saved unapplied discovery result even when no product ranges have been accepted', async t => {
  const f = await fixture(t);
  await updateProductAnalysis(f.root, data => ({ ...data, products: [], intervals: [] }), f.probe);
  const dir = join(f.root, '.film/product-discovery'); await mkdir(dir);
  const name = createHash('sha256').update(JSON.stringify(f.source.id)).digest('hex') + '.json';
  await writeFile(join(dir, name), JSON.stringify({ version: 1, sourceId: f.source.id, runs: [{ id: 'unapplied', status: 'complete' }] }));
  const state = await readTranscriptReview(f.root, f.source.id);
  assert.equal(state.impact.discovery, true); assert.deepEqual(state.impact.ranges, []);
});

test('source or raw segment changes invalidate review identity instead of reusing or overwriting edits', async t => {
  const f = await fixture(t), state = await readTranscriptReview(f.root, f.source.id);
  await writeFile(join(f.root, 'assets/live.mp4'), 'changed-synthetic-original');
  await assert.rejects(save(f, state, state.seams[0]), { status: 409 });
  assert.equal(f.calls(), 3);
});

test('missing raw manifest never silently falls back to an older transcript after a manual revision', async t => {
  const f = await fixture(t); let state = await readTranscriptReview(f.root, f.source.id);
  for (const seam of state.seams) state = await save(f, state, seam);
  await rm(f.cache + '.segments.json');
  await assert.rejects(readProductTranscript(f.root, f.source), { status: 409 });
  assert.equal(f.calls(), 3);
});

test('existing complete script-reviewed transcript remains unchanged when seams are only inspected', async t => {
  const f = await fixture(t), pending = JSON.parse(await readFile(f.cache, 'utf8'));
  const legacy = { ...pending, status: 'complete', cues: [cue('原脚本结果', 100, 5500)], words: [], text: '原脚本结果', boundaryReview: { kind: 'agent-local-boundary-review' } };
  await writeFile(f.cache, JSON.stringify(legacy));
  const bytes = await readFile(f.cache, 'utf8');
  const state = await readTranscriptReview(f.root, f.source.id);
  assert.match(state.legacyReview, /agent-local-boundary-review/);
  assert.deepEqual((await readProductTranscript(f.root, f.source)).cues, legacy.cues);
  assert.equal(await readFile(f.cache, 'utf8'), bytes); assert.equal(f.calls(), 3);
});

test('local save failure leaves persisted revision intact and explicit retry never retranscribes', async t => {
  const f = await fixture(t), state = await readTranscriptReview(f.root, f.source.id);
  await mkdir(f.cache + '.review.json');
  await assert.rejects(save(f, state, state.seams[0]));
  await rm(f.cache + '.review.json', { recursive: true });
  const next = await save(f, state, state.seams[0]); assert.equal(next.revision, 1); assert.equal(f.calls(), 3);
});

test('completed local review clears prior live boundary failure without starting services', async t => {
  const f = await fixture(t); let state = await readTranscriptReview(f.root, f.source.id);
  for (const seam of state.seams) state = await save(f, state, seam);
  const liveDir = join(f.root, '.film/live-analysis'); await mkdir(liveDir);
  const stateFile = join(liveDir, createHash('sha256').update(f.source.id).digest('hex') + '.json');
  await writeFile(stateFile, JSON.stringify({ version: 1, sourceId: f.source.id, transcription: { status: 'failed', code: 'ASR_BOUNDARY_REVIEW' }, analysis: { status: 'idle' } }));
  const controller = createLiveAnalysis({ probeSource: f.probe });
  const view = await controller.view(f.root, f.source.id);
  assert.equal(view.transcription.status, 'complete'); assert.equal(view.transcription.code, undefined); assert.equal(f.calls(), 3);
});

test('raw response archives survive parsing failure and no uncertain request is automatically repeated', async t => {
  const f = await fixture(t), source = { ...f.source, id: 'invalid-response' }; let calls = 0;
  const payload = { audio_info: { duration: 6000 }, result: { text: '服务原始内容', utterances: [{ start_time: 0, end_time: 90000, text: '越界' }] } };
  const options = { getKey: async () => 'fake', readAudio: async () => Buffer.from('synthetic audio'), runProvider: async (_verb, args, ctx) => {
    calls++; await ctx.onResponse({ requestId: args.requestId, provider: 'doubao', httpStatus: 200, body: payload });
    return { index: [{ text: '越界', words: [{ token: '越界', start: 0, end: 90 }], cues: [cue('越界', 0, 90000)] }] };
  } };
  await assert.rejects(transcribeProductSource(f.root, source, options), /invalid timestamps/);
  await assert.rejects(transcribeProductSource(f.root, source, options), /may have been submitted/);
  assert.equal(calls, 1);
  const rawDir = join(f.root, '.film/product-transcripts/raw-responses');
  const receipts = await Promise.all((await readdir(rawDir)).map(async file => JSON.parse(await readFile(join(rawDir, file), 'utf8'))));
  assert.equal(receipts.length, 4); assert.deepEqual(receipts.find(item => item.sourceId === source.id).body, payload);
});

test('raw response save failure preserves its error and never resubmits a provider request', async t => {
  const f = await fixture(t), source = { ...f.source, id: 'response-save-failure' }; let calls = 0;
  const rawDir = join(f.root, '.film/product-transcripts/raw-responses'); await rm(rawDir, { recursive: true }); await writeFile(rawDir, 'blocked-by-synthetic-file');
  const options = { getKey: async () => 'fake', readAudio: async () => Buffer.from('synthetic audio'), runProvider: async (_verb, args, ctx) => { calls++; await ctx.onResponse({ requestId: args.requestId, body: { result: 'raw' } }); assert.fail('archive failure must stop parsing'); } };
  await assert.rejects(transcribeProductSource(f.root, source, options), error => error.code === 'ASR_RESPONSE_SAVE_FAILED');
  await assert.rejects(transcribeProductSource(f.root, source, options), /may have been submitted/);
  assert.equal(calls, 1);
});
