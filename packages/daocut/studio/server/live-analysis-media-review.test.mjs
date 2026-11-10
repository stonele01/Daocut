// Isolated text/model/tool fixtures. No real model, ASR, source video or NAS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { createLiveAnalysis } from './live-analysis.mjs';
import { readProductAnalysis, writeProductAnalysis } from './product-analysis.mjs';
import { TEXT_STRUCTURE_VERSION } from './text-structure.mjs';

const base = resolve(import.meta.dirname, '../../../../.tmp/media-review-integration-20261110');
const sourceBytes = 'synthetic source bytes, not playable; all media tools are mocked';
const sourceSha = createHash('sha256').update(sourceBytes).digest('hex');
const scope = { sourceId: 's', productId: 'p', intervalId: 'first', startMs: 10000, endMs: 19000, lectureOnly: true };
const cues = [
  { startMs: 10000, endMs: 13000, text: '早上赶车时腾不出手拧杯盖。' },
  { startMs: 13000, endMs: 16000, text: '这款模拟杯可以单手按压打开。' },
  { startMs: 16000, endMs: 19000, text: '需要的确认规格后现在下单。' },
  { startMs: 30000, endMs: 33000, text: '返场这一段不能混入首次讲解。' },
];
const probeSource = async () => ({ duration: 100 });
const compact = { schema: 'complete-speech-v1', candidates: [
  { firstCue: 0, lastCue: 0, tags: ['痛点'] },
  { firstCue: 1, lastCue: 1, tags: ['卖点'] },
  { firstCue: 2, lastCue: 2, tags: ['逼单'] },
], issues: [] };
const legacyPayload = { version: TEXT_STRUCTURE_VERSION, candidates: [
  { cueRange: [0, 0], tags: ['痛点'], details: { subtypes: [], reason: '旧完整原话', evidence: ['ASR'], context: '', repetition: '', review: [] } },
  { cueRange: [1, 1], tags: ['卖点'], details: { subtypes: [], reason: '旧完整原话', evidence: ['ASR'], context: '', repetition: '', review: [] } },
  { cueRange: [2, 2], tags: ['行动指令'], details: { subtypes: [], reason: '旧完整原话', evidence: ['ASR'], context: '', repetition: '', review: [] } },
], issues: [] };

function completeReview(selected = scope) {
  const range = { startMs: selected.startMs, endMs: selected.endMs };
  return { version: 'product-media-review-v1', key: createHash('sha256').update(JSON.stringify([sourceSha, range])).digest('hex'), sourceSha,
    status: 'complete', scope: range, segments: [{ ...range,
      visual: { status: 'sampled', sampleTimesMs: [range.startMs, range.startMs + 3000], artifactSha256: 'd'.repeat(64) },
      audio: { status: 'technical-checked', hasAudio: true, peakDb: -8, integratedLufs: -20, measurementRange: range }, issues: [] }],
    issues: [], speechVerified: false, continuousActionVerified: false };
}
async function setup(t) {
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'case-'));
  t.after(async () => { assert.ok(resolve(root).startsWith(`${base}${sep}`)); await rm(root, { recursive: true, force: true }); });
  t.mock.method(globalThis, 'fetch', () => { throw Error('No real model, ASR, network or NAS request'); });
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'assets/source.mp4'), sourceBytes);
  await writeFile(join(root, 'film.html'), 'existing parent film stays unchanged');
  await writeProductAnalysis(root, { version: 1,
    sources: [{ id: 's', assetPath: 'assets/source.mp4', durationMs: 100000 }],
    products: [{ id: 'p', name: '模拟商品', sourceIds: ['s'] }], intervals: [
      { id: 'first', sourceId: 's', productId: 'p', startMs: 10000, endMs: 19000 },
      { id: 'return', sourceId: 's', productId: 'p', startMs: 30000, endMs: 33000 },
    ], candidates: [] }, probeSource);
  return { root, options: { modelIdentity: 'isolated-media-review-model', probeSource,
    transcribe: async () => assert.fail('saved transcript must be reused'), readTranscript: async () => ({ cues, words: [] }) } };
}
async function analyze(route, root) {
  await route.startAnalysis(root, scope); await route.wait(root, 's');
  return route.view(root, 's', 'first', 'p', scope);
}
const candidatesFile = root => readFile(join(root, '.film/product-analysis.json'), 'utf8');
async function assertParent(root) { assert.equal(await readFile(join(root, 'film.html'), 'utf8'), 'existing parent film stays unchanged'); }
async function seedOld(route, root) { return route.importShared(root, 's', scope, structuredClone(legacyPayload), { sha256: 'a'.repeat(64) }); }
async function request(route, root, body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]); req.method = 'POST'; req.url = '/live-analysis/review-media'; req.headers = { 'content-type': 'application/json' };
  let value, status;
  const res = { writeHead(code) { status = code; }, end(text) { value = JSON.parse(text); } };
  const handled = await route(req, res, root, 'live-analysis/review-media');
  return { handled, status, value };
}

test('new single-lecture analysis saves scoped media review once without treating sampled frames as semantic verification', async t => {
  const c = await setup(t); let modelCalls = 0, mediaCalls = 0;
  const route = createLiveAnalysis({ ...c.options,
    modelClient: async ({ input }) => { modelCalls++; assert.equal(JSON.parse(input).cues.length, 3); return structuredClone(compact); },
    mediaReview: async (root, source, selected, candidates) => {
      mediaCalls++; assert.equal(root, c.root); assert.equal(source.id, 's');
      assert.deepEqual([selected.sourceId, selected.productId, selected.intervalId, selected.startMs, selected.endMs], ['s','p','first',10000,19000]);
      assert.equal(candidates.length, 3); assert.ok(candidates.every(item => item.startMs >= 10000 && item.endMs <= 19000));
      return completeReview(selected);
    },
  });
  const done = await analyze(route, c.root);
  assert.equal(done.analysis.status, 'complete'); assert.equal(modelCalls, 1); assert.equal(mediaCalls, 1);
  assert.deepEqual(done.analysis.mediaReview, completeReview());
  assert.equal(done.analysis.mediaReview.speechVerified, false);
  assert.equal(done.analysis.mediaReview.continuousActionVerified, false);
  assert.ok(done.analysis.coverage.every(item => item.audioRanges.length === 0 && item.videoRanges.length === 0), 'technical sampling must not assert continuous semantic coverage');
  const before = await candidatesFile(c.root);
  await analyze(route, c.root);
  assert.equal(mediaCalls, 1); assert.equal(modelCalls, 1);
  assert.equal(await candidatesFile(c.root), before); await assertParent(c.root);
});

test('saved media review survives reopen and shared export/import without re-running either service', async t => {
  const c = await setup(t);
  const original = createLiveAnalysis({ ...c.options, modelClient: async () => structuredClone(compact), mediaReview: async () => completeReview() });
  await analyze(original, c.root);
  const payload = await original.exportShared(c.root, 's', 'first');
  assert.deepEqual(payload.mediaReview, completeReview());
  const reject = async () => assert.fail('reopen/shared reuse must not execute model or media tool');
  const reopened = createLiveAnalysis({ ...c.options, modelClient: reject, mediaReview: reject });
  assert.deepEqual((await reopened.view(c.root, 's', 'first', 'p', scope)).analysis.mediaReview, payload.mediaReview);
  await analyze(reopened, c.root);
  const receiver = await setup(t), reused = createLiveAnalysis({ ...receiver.options, modelClient: reject, mediaReview: reject });
  await reused.importShared(receiver.root, 's', scope, payload, { sha256: 'b'.repeat(64) });
  const state = await analyze(reused, receiver.root);
  assert.deepEqual(state.analysis.mediaReview, payload.mediaReview);
  const imported = (await readProductAnalysis(receiver.root)).analysis.candidates;
  assert.deepEqual(imported.map(candidate => candidate.text), cues.slice(0,3).map(cue => cue.text));
  assert.ok(imported.every(candidate => candidate.details.evidence.length === 1 && candidate.details.evidence[0] === 'ASR'));
  await assertParent(c.root); await assertParent(receiver.root);
});

test('tool failure preserves successful text analysis and explicit local retry never resubmits text', async t => {
  const c = await setup(t); let modelCalls = 0, mediaCalls = 0;
  const route = createLiveAnalysis({ ...c.options, modelClient: async () => { modelCalls++; return structuredClone(compact); },
    mediaReview: async () => { mediaCalls++; if (mediaCalls === 1) throw Error('simulated local frame extraction failure'); return completeReview(); },
  });
  const done = await analyze(route, c.root);
  assert.equal(done.analysis.status, 'complete'); assert.equal(done.analysis.mediaReview.status, 'failed');
  assert.equal(modelCalls, 1); assert.equal(mediaCalls, 1);
  const before = await candidatesFile(c.root);
  const reopened = await route.view(c.root, 's', 'first', 'p', scope);
  assert.equal(reopened.analysis.mediaReview.status, 'failed'); assert.equal(mediaCalls, 1);
  await route.reviewMedia(c.root, { ...scope, confirmed: true });
  const restored = await route.view(c.root, 's', 'first', 'p', scope);
  assert.equal(restored.analysis.status, 'complete'); assert.equal(restored.analysis.mediaReview.status, 'complete');
  assert.equal(modelCalls, 1); assert.equal(mediaCalls, 2);
  await route.reviewMedia(c.root, { ...scope, confirmed: true });
  assert.equal(mediaCalls, 2, 'successful stored review is reused');
  assert.equal(await candidatesFile(c.root), before); await assertParent(c.root);
});

test('changed candidate boundaries mark old checks stale and only explicit checking refreshes the local record', async t => {
  const c = await setup(t); let modelCalls = 0, mediaCalls = 0;
  const route = createLiveAnalysis({ ...c.options,
    modelClient: async () => { modelCalls++; return structuredClone(compact); },
    mediaReview: async () => { mediaCalls++; return completeReview(); },
  });
  await analyze(route, c.root);
  const data = (await readProductAnalysis(c.root)).analysis;
  data.candidates[0].endMs = 16000; data.candidates[0].cueRange = [0, 1];
  await writeProductAnalysis(c.root, data, probeSource);
  const before = await candidatesFile(c.root);
  const stale = await route.view(c.root, 's', 'first', 'p', scope);
  assert.equal(stale.analysis.mediaReviewStale, true);
  assert.equal(mediaCalls, 1);
  await route.reviewMedia(c.root, { ...scope, confirmed: true });
  assert.equal(mediaCalls, 2, 'explicit check must not silently reuse the previous candidate boundaries');
  assert.equal(modelCalls, 1);
  assert.equal((await route.view(c.root, 's', 'first', 'p', scope)).analysis.mediaReviewStale, false);
  assert.equal(await candidatesFile(c.root), before); await assertParent(c.root);
});

test('concurrent explicit checks coalesce or reject duplicate work without duplicate tools', { timeout: 5000 }, async t => {
  const c = await setup(t); let calls = 0, release, entered;
  const inTool = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const route = createLiveAnalysis({ ...c.options, modelClient: async () => assert.fail('old analysis is reused'),
    mediaReview: async () => { calls++; entered(); await gate; return completeReview(); },
  });
  await seedOld(route, c.root);
  assert.equal(typeof route.reviewMedia, 'function');
  const first = route.reviewMedia(c.root, { ...scope, confirmed: true });
  await inTool;
  const second = Promise.resolve().then(() => route.reviewMedia(c.root, { ...scope, confirmed: true }));
  release();
  const results = await Promise.allSettled([first, second]);
  assert.equal(calls, 1);
  assert.equal(results[0].status, 'fulfilled');
  if (results[1].status === 'rejected') assert.equal(results[1].reason.status, 409);
  assert.equal((await route.view(c.root, 's', 'first', 'p', scope)).analysis.mediaReview.status, 'complete');
  await assertParent(c.root);
});

test('old analysis remains untouched on import, reopening and analyze; only explicit media check adds a supplement', async t => {
  const c = await setup(t); let calls = 0;
  const route = createLiveAnalysis({ ...c.options, modelClient: async () => assert.fail('legacy result must not be rerun'), mediaReview: async () => { calls++; return completeReview(); } });
  await seedOld(route, c.root);
  const before = await candidatesFile(c.root);
  assert.equal((await analyze(route, c.root)).analysis.mediaReview, undefined); assert.equal(calls, 0);
  await route.reviewMedia(c.root, { ...scope, confirmed: true });
  assert.equal(calls, 1); assert.equal(await candidatesFile(c.root), before);
  const supplement = (await route.view(c.root, 's', 'first', 'p', scope)).analysis.mediaReview;
  assert.equal(supplement.status, 'complete');
  await assertParent(c.root);
});

test('explicit media checks require confirmation and reject changed lecture boundaries before tools run', async t => {
  const c = await setup(t); let calls = 0;
  const route = createLiveAnalysis({ ...c.options, modelClient: async () => assert.fail('no text request'), mediaReview: async () => { calls++; return completeReview(); } });
  await seedOld(route, c.root);
  assert.equal(typeof route.reviewMedia, 'function');
  await assert.rejects(route.reviewMedia(c.root, { ...scope, confirmed: false }), /确认/);
  await assert.rejects(route.reviewMedia(c.root, { ...scope, confirmed: true, startMs: 11000 }), /边界|范围|改变|变化/);
  await assert.rejects(route.reviewMedia(c.root, { ...scope, confirmed: true, intervalId: 'return' }), /边界|范围|改变|变化/);
  assert.equal(calls, 0); await assertParent(c.root);
});

test('POST review-media routes the selected lecture to local tools and exposes saved status', async t => {
  const c = await setup(t); let calls = 0;
  const route = createLiveAnalysis({ ...c.options, modelClient: async () => assert.fail('no text request'), mediaReview: async () => { calls++; return completeReview(); } });
  await seedOld(route, c.root);
  const result = await request(route, c.root, { ...scope, confirmed: true });
  assert.equal(result.handled, true); assert.equal(result.status, 200); assert.equal(calls, 1);
  assert.equal((await route.view(c.root, 's', 'first', 'p', scope)).analysis.mediaReview.status, 'complete');
});
