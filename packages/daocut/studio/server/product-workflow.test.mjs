import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createLiveAnalysis } from './live-analysis.mjs';
import { createProductDiscovery } from './product-discovery-route.mjs';
import { createProductWorkflow } from './product-workflow.mjs';
import { readProductAnalysis, updateProductAnalysis } from './product-analysis.mjs';
import { readProductTranscript } from './product-transcription.mjs';
import { TEXT_STRUCTURE_PROMPT } from './text-structure.mjs';
import { readSourceTakes, SOURCE_TAKES_FILE } from './source-takes.mjs';

const base = resolve('../../.tmp/desktop-live-services-20261104/backend');
const probe = async () => ({ duration: 20 });
const details = { subtypes: [], reason: '模拟连续原话', evidence: ['ASR'], context: '', repetition: '', review: [] };
async function fixture(t, options = {}) {
  await mkdir(base, { recursive: true }); const root = await mkdtemp(join(base, 'case-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.mock.method(globalThis, 'fetch', () => { throw Error('real network prohibited'); });
  await mkdir(join(root, 'assets')); await writeFile(join(root, 'assets/live.mp4'), 'synthetic-source'); await writeFile(join(root, 'film.html'), 'untouched-film');
  let transcript = options.transcript ?? null, asr = 0, text = 0, fail = false, gate, asrFailure, failAt = 0;
  const cues = Array.from({ length: 5 }, (_, index) => ({ text: `模拟第${index + 1}句话。${options.longText ? '连续原话'.repeat(100) : ''}`, startMs: index * 2000, endMs: index * 2000 + 1500 }));
  const service = { transcription: { enabled: true, provider: 'doubao', name: '豆包语音识别', endpoint: 'https://openspeech.bytedance.com/flash', model: 'volc.bigasr.auc_turbo' }, text: { enabled: true, provider: 'deepseek', name: 'DeepSeek', endpoint: 'https://api.deepseek.com/responses', model: 'deepseek-flash' } };
  const requestedIdentities = [];
  const readTranscript = options.diskTranscript ? readProductTranscript : async () => transcript;
  const modelClient = async ({ input, onReceipt, expectedIdentity }) => {
    requestedIdentities.push(expectedIdentity);
    text++; if (gate) await gate; if (fail || text === failAt) throw Object.assign(Error('mock timeout'), { code: 'MODEL_TIMEOUT' });
    await onReceipt?.({ id: `mock-${text}`, model: 'deepseek-flash', usage: { input_tokens: 12, output_tokens: 6 } });
    const parsed = JSON.parse(input);
    return parsed.intervalId ? { candidates: [{ firstCue: 0, lastCue: parsed.cues.length - 1, tags: ['卖点'], details }], issues: [] }
      : options.twoProducts ? { products: [{ key: 'p', name: '模拟商品', variant: '', aliases: [], evidence: [0] }, { key: 'q', name: '第二个商品', variant: '', aliases: [], evidence: [2] }], ranges: [{ key: 'p', firstCue: 0, lastCue: 1, kind: 'lecture', reason: '第一个品', evidence: [0] }, { key: 'q', firstCue: 2, lastCue: 4, kind: 'lecture', reason: '第二个品', evidence: [2] }], issues: [] }
      : { products: [{ key: 'p', name: '模拟商品', variant: '', aliases: [], evidence: [0] }], ranges: [{ key: 'p', firstCue: 0, lastCue: 4, kind: 'lecture', reason: '完整讲解', evidence: [0, 4] }], issues: [] };
  };
  const liveOptions = { transcribe: async () => { asr++; if (asrFailure) throw asrFailure; transcript = { cues, words: [] }; return transcript; }, modelClient, modelIdentity: () => service.text, readTranscript, probeSource: probe, ...(options.structureWindowPolicy ? { structureWindowPolicy: options.structureWindowPolicy } : {}) };
  const discoveryOptions = { modelClient, modelIdentity: () => service.text, readTranscript, probeSource: probe };
  const live = createLiveAnalysis(liveOptions), discovery = createProductDiscovery(discoveryOptions);
  const make = (overrides = {}) => createProductWorkflow({ liveAnalysis: createLiveAnalysis(liveOptions), discovery: createProductDiscovery(discoveryOptions), analysisServices: async () => service, readTranscript, probeSource: probe, ...overrides });
  const workflow = make(); await options.beforeRegister?.(root); const registered = await workflow.registerSource(root, { assetPath: 'assets/live.mp4' });
  return { root, workflow, live, discovery, make, source: registered.source, cues, service, requestedIdentities, counts: () => ({ asr, text }), fail: value => { fail = value; }, failAt: value => { failAt = value; }, failAsr: value => { asrFailure = value; }, gate: value => { gate = value; }, setTranscript: value => { transcript = value; } };
}
const plan = (f, action, extra = {}) => f.workflow.plan(f.root, { sourceId: f.source.id, action, ...extra });
const execute = (f, p, extra = {}) => f.workflow.execute(f.root, { confirmed: true, plan: p, ...extra });
const settle = f => f.workflow.wait(f.root, f.source.id);

for (const count of [1, 2]) test(`one preparation confirmation transcribes the full source and applies ${count} actual products`, async t => {
  const f = await fixture(t, { twoProducts: count === 2 });
  const preparation = await plan(f, 'transcription', { prepare: true });
  assert.equal(preparation.nextStage.service.model, 'deepseek-flash');
  await Promise.all([execute(f, preparation), execute(f, preparation)]); await settle(f);
  const result = (await readProductAnalysis(f.root)).analysis;
  assert.equal(result.products.length, count); assert.equal(result.intervals.length, count); assert.equal(result.candidates.length, 0);
  assert.deepEqual(f.counts(), { asr: 1, text: 1 });
  assert.equal((await f.workflow.status(f.root, f.source.id)).preparation.status, 'complete');
  assert.equal((await f.workflow.status(f.root, f.source.id)).discoveryReady, true);
  const reopened = f.make(); await reopened.status(f.root, f.source.id);
  assert.deepEqual(f.counts(), { asr: 1, text: 1 }, 'reopening is read-only');
});

test('preparation reuses a completed transcript and stops on discovery failure without automatic retry', async t => {
  const f = await fixture(t); f.setTranscript({ cues: f.cues }); f.fail(true);
  await execute(f, await plan(f, 'discovery', { prepare: true })); await settle(f);
  assert.deepEqual(f.counts(), { asr: 0, text: 1 });
  assert.equal((await f.workflow.status(f.root, f.source.id)).preparation.status, 'failed');
  f.workflow = f.make(); await f.workflow.status(f.root, f.source.id);
  assert.deepEqual(f.counts(), { asr: 0, text: 1 });
  f.fail(false); await execute(f, await plan(f, 'discovery', { prepare: true, retry: true }), { retryAcknowledged: true }); await settle(f);
  assert.deepEqual(f.counts(), { asr: 0, text: 2 });
  assert.equal((await readProductAnalysis(f.root)).analysis.products.length, 1);
});

test('preparation stops before discovery when transcription needs local seam review', async t => {
  const f = await fixture(t);
  f.failAsr(Object.assign(Error('字幕接缝待核对'), { code: 'ASR_BOUNDARY_REVIEW', localReviewRequired: true }));
  await execute(f, await plan(f, 'transcription', { prepare: true })); await settle(f);
  assert.deepEqual(f.counts(), { asr: 1, text: 0 });
  assert.equal((await f.workflow.status(f.root, f.source.id)).preparation.status, 'failed');
});

test('preparation checks both service configurations before starting audio', async t => {
  const f = await fixture(t), preparation = await plan(f, 'transcription', { prepare: true });
  f.service.text.model = 'changed-model';
  await assert.rejects(execute(f, preparation), { status: 409 });
  assert.deepEqual(f.counts(), { asr: 0, text: 0 });
  f.service.text.enabled = false;
  const disabled = await plan(f, 'transcription', { prepare: true }); assert.equal(disabled.enabled, false);
});

test('combined preparation keeps saved manual product ranges and returns a reviewable proposal', async t => {
  const f = await fixture(t); f.setTranscript({ cues: f.cues });
  await updateProductAnalysis(f.root, data => { data.products.push({ id: 'manual', name: '人工商品', sourceIds: [f.source.id] }); data.intervals.push({ id: 'manual-range', sourceId: f.source.id, productId: 'manual', startMs: 0, endMs: 20000 }); return data; }, probe);
  const before = (await readProductAnalysis(f.root)).analysis;
  const initial = await f.workflow.status(f.root, f.source.id);
  assert.equal(initial.ready, true, 'manual scopes remain available for editing');
  assert.equal(initial.discoveryReady, false, 'a manual whole-video card is not completed discovery');
  assert.equal(initial.phase, 'discovery');
  assert.equal(initial.needsReview, false);
  assert.deepEqual(f.counts(), { asr: 0, text: 0 });
  await execute(f, await plan(f, 'discovery', { prepare: true })); await settle(f);
  assert.deepEqual((await readProductAnalysis(f.root)).analysis, before);
  assert.equal((await f.workflow.status(f.root, f.source.id)).needsReview, true);
  assert.equal((await f.workflow.status(f.root, f.source.id)).discoveryReady, false);
  assert.deepEqual(f.counts(), { asr: 0, text: 1 });
  const result = await f.workflow.status(f.root, f.source.id);
  await f.discovery.apply(f.root, { sourceId: f.source.id, runId: result.discovery.runId, expected: before, replaceReviewed: true });
  const applied = await f.make().status(f.root, f.source.id);
  assert.equal(applied.discoveryReady, true);
  assert.equal(applied.phase, 'ready');
  assert.equal(applied.needsReview, false);
  assert.deepEqual(f.counts(), { asr: 0, text: 1 });
});

test('ordinary existing video is registered once without inventing a product or contacting services', async t => {
  const f = await fixture(t);
  const again = await f.workflow.registerSource(f.root, { assetPath: 'assets/live.mp4' });
  assert.equal(again.source.id, f.source.id); assert.equal(again.analysis.sources.length, 1); assert.deepEqual(again.analysis.products, []);
  assert.equal((await f.workflow.status(f.root, f.source.id)).phase, 'transcription');
  assert.deepEqual(f.counts(), { asr: 0, text: 0 });
});

test('audio and text require separate frozen plans; cached results and restart never request again', async t => {
  const f = await fixture(t); const audio = await plan(f, 'transcription');
  assert.equal(audio.service.provider, 'doubao'); assert.equal(audio.requestCount, 1); assert.equal(audio.cost.estimate, null);
  await assert.rejects(f.workflow.execute(f.root, { plan: audio }), { status: 400 });
  await execute(f, audio); await settle(f);
  assert.deepEqual(f.counts(), { asr: 1, text: 0 });
  assert.equal((await f.workflow.status(f.root, f.source.id)).phase, 'discovery');
  const split = await plan(f, 'discovery'); assert.equal(split.transcriptSegments, 5); assert.equal(split.requestCount, 1);
  await execute(f, split); await settle(f);
  let data = (await readProductAnalysis(f.root)).analysis; assert.equal(data.products.length, 1); assert.equal(data.intervals.length, 1);
  const scope = { productId: data.products[0].id, intervalId: data.intervals[0].id };
  const structure = await plan(f, 'analysis', scope); await execute(f, structure); await settle(f);
  data = (await readProductAnalysis(f.root)).analysis;
  assert.equal(data.candidates.length, 1); assert.equal(data.candidates[0].text, f.cues.map(c => c.text).join(''));
  assert.deepEqual([data.candidates[0].startMs, data.candidates[0].endMs], [0, 9500]);
  assert.deepEqual(f.counts(), { asr: 1, text: 2 });
  assert.deepEqual(f.requestedIdentities, [f.service.text, f.service.text], 'both text stages pass the same frozen public model identity to the adapter');
  const reopened = f.make(); const cached = await reopened.plan(f.root, { action: 'analysis', sourceId: f.source.id, ...scope });
  assert.equal(cached.cached, true); assert.equal(cached.requestCount, 0);
  await reopened.execute(f.root, { confirmed: true, plan: cached });
  assert.deepEqual(f.counts(), { asr: 1, text: 2 });
  assert.equal(await readFile(join(f.root, 'film.html'), 'utf8'), 'untouched-film');
  assert.equal(await readFile(join(f.root, 'assets/live.mp4'), 'utf8'), 'synthetic-source');
});

test('bound transcript works without audio service; changed model or transcript invalidates confirmation', async t => {
  const f = await fixture(t); f.setTranscript({ cues: f.cues }); f.service.transcription.enabled = false;
  const audio = await plan(f, 'transcription'); assert.equal(audio.cached, true); assert.equal(audio.requestCount, 0);
  const split = await plan(f, 'discovery'); assert.equal(split.enabled, true);
  f.service.text.model = 'new-model'; await assert.rejects(execute(f, split), { status: 409 });
  const next = await plan(f, 'discovery'); f.setTranscript({ cues: f.cues.map(c => ({ ...c, text: c.text + '变更' })) });
  await assert.rejects(execute(f, next), { status: 409 }); assert.deepEqual(f.counts(), { asr: 0, text: 0 });
});

test('duplicate confirmation is deduplicated; failed text never automatically retries', async t => {
  const f = await fixture(t); f.setTranscript({ cues: f.cues }); f.fail(true);
  const split = await plan(f, 'discovery'); await Promise.all([execute(f, split), execute(f, split)]); await settle(f);
  assert.equal(f.counts().text, 1); assert.equal((await f.workflow.status(f.root, f.source.id)).discovery.status, 'failed');
  await assert.rejects(execute(f, split), { status: 409 }); assert.equal(f.counts().text, 1);
  f.fail(false); const retry = await plan(f, 'discovery', { retry: true }); assert.equal(retry.retryRequired, true);
  await assert.rejects(execute(f, retry), { status: 409 });
  await execute(f, retry, { retryAcknowledged: true }); await settle(f); assert.equal(f.counts().text, 2);
});

test('manual product corrections survive a new discovery run and need reviewed application', async t => {
  const f = await fixture(t); f.setTranscript({ cues: f.cues }); await execute(f, await plan(f, 'discovery')); await settle(f);
  await updateProductAnalysis(f.root, data => { data.products[0].name = '人工商品名'; return data; }, probe);
  await execute(f, await plan(f, 'discovery', { rerun: true })); await settle(f);
  assert.equal((await readProductAnalysis(f.root)).analysis.products[0].name, '人工商品名');
  assert.equal((await f.workflow.status(f.root, f.source.id)).needsReview, true);
});

test('audio failure survives controller restart and requires an explicit retry confirmation', async t => {
  const f = await fixture(t); f.failAsr(Error('mock uncertain upload'));
  const audio = await plan(f, 'transcription'); await Promise.all([execute(f, audio), execute(f, audio)]); await settle(f);
  f.workflow = f.make(); assert.equal((await f.workflow.status(f.root, f.source.id)).transcription.status, 'failed');
  await assert.rejects(execute(f, audio), { status: 409 });
  const retry = await plan(f, 'transcription', { retry: true });
  await assert.rejects(execute(f, retry), { status: 409 }); assert.equal(f.counts().asr, 1);
  f.failAsr(null); await execute(f, retry, { retryAcknowledged: true }); await settle(f);
  assert.deepEqual(f.counts(), { asr: 2, text: 0 });
});

test('saved audio boundary review is a local repair state and cannot trigger another paid retry', async t => {
  const f = await fixture(t); f.failAsr(Object.assign(Error('boundary mismatch'), { code: 'ASR_BOUNDARY_REVIEW' }));
  await execute(f, await plan(f, 'transcription')); await settle(f); f.workflow = f.make();
  const retry = await plan(f, 'transcription', { retry: true });
  assert.equal(retry.localReviewRequired, true); assert.equal(retry.enabled, false);
  await assert.rejects(execute(f, retry, { retryAcknowledged: true }), { status: 403 }); assert.equal(f.counts().asr, 1);
});

test('range changes invalidate a structure confirmation and authorization-time changes send nothing', async t => {
  const f = await fixture(t); f.setTranscript({ cues: f.cues }); await execute(f, await plan(f, 'discovery')); await settle(f);
  const data = (await readProductAnalysis(f.root)).analysis, scope = { productId: data.products[0].id, intervalId: data.intervals[0].id };
  const structure = await plan(f, 'analysis', scope);
  await updateProductAnalysis(f.root, data => { data.intervals[0].endMs = 7500; return data; }, probe);
  await assert.rejects(execute(f, structure), { status: 409 });
  f.workflow = f.make({ authorizeTask: async () => { f.service.text.model = 'changed-after-approval'; } });
  await assert.rejects(execute(f, await plan(f, 'analysis', scope)), { status: 409 }); assert.equal(f.counts().text, 1);
});

test('failed structure can explicitly resume after restart, preserving multi-sentence candidates and receipts', async t => {
  const f = await fixture(t); f.setTranscript({ cues: f.cues }); await execute(f, await plan(f, 'discovery')); await settle(f);
  const data = (await readProductAnalysis(f.root)).analysis, scope = { productId: data.products[0].id, intervalId: data.intervals[0].id };
  f.fail(true); const structure = await plan(f, 'analysis', scope); await execute(f, structure); await settle(f);
  f.workflow = f.make(); await assert.rejects(execute(f, structure), { status: 409 });
  const retry = await plan(f, 'analysis', { ...scope, retry: true });
  await assert.rejects(execute(f, retry), { status: 409 }); f.fail(false);
  await Promise.all([execute(f, retry, { retryAcknowledged: true }), execute(f, retry, { retryAcknowledged: true })]); await settle(f);
  assert.equal(f.counts().text, 3); assert.equal((await plan(f, 'analysis', scope)).cached, true);
  const statePath = join(f.root, '.film', 'live-analysis', (await readdir(join(f.root, '.film', 'live-analysis')))[0]);
  const saved = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(Object.values(saved.attempts).at(-1).windows[0].receipt.usage.input_tokens, 12);
  assert.equal((await readProductAnalysis(f.root)).analysis.candidates[0].text, f.cues.map(c => c.text).join(''));
});

test('unbound local subtitles show source and coverage, bind explicitly and reuse after restart', async t => {
  const f = await fixture(t, { diskTranscript: true });
  await writeFile(join(f.root, 'assets/live.vtt'), 'WEBVTT\n\n00:00.000 --> 00:01.500\n同源字幕\n');
  let status = await f.workflow.status(f.root, f.source.id);
  assert.equal(status.binding.kind, 'vtt'); assert.equal(status.binding.assetPath, 'assets/live.mp4'); assert.deepEqual(status.binding.coverage, [[0, 1500]]);
  assert.equal((await plan(f, 'transcription')).enabled, false);
  await assert.rejects(f.workflow.bindTranscript(f.root, { sourceId: f.source.id, ...status.binding }), { status: 400 });
  await f.workflow.bindTranscript(f.root, { sourceId: f.source.id, sourceConfirmed: true, ...status.binding });
  f.workflow = f.make(); status = await f.workflow.status(f.root, f.source.id);
  assert.equal(status.phase, 'discovery'); assert.equal(status.transcription.status, 'complete');
  assert.equal((await plan(f, 'transcription')).requestCount, 0); assert.deepEqual(f.counts(), { asr: 0, text: 0 });
});

test('ASR adapter receives a frozen source fingerprint and refuses a replaced source before invocation', async t => {
  const f = await fixture(t);
  await f.live.startTranscription(f.root, f.source.id, false, { provider: 'doubao', model: 'volc.bigasr.auc_turbo', endpoint: f.service.transcription.endpoint }, 'old-source-fingerprint');
  await f.live.wait(f.root, f.source.id);
  assert.equal(f.counts().asr, 0);
  assert.equal((await f.live.view(f.root, f.source.id)).transcription.retryBlocked, false);
});

test('multi-window structure retry requests only unfinished windows after controller restart', async t => {
  const f = await fixture(t, { longText: true, structureWindowPolicy: { maxInputBytes: Buffer.byteLength(TEXT_STRUCTURE_PROMPT) + 2300, contextCues: 0 } });
  f.setTranscript({ cues: f.cues }); await execute(f, await plan(f, 'discovery')); await settle(f);
  const data = (await readProductAnalysis(f.root)).analysis, scope = { productId: data.products[0].id, intervalId: data.intervals[0].id };
  const structure = await plan(f, 'analysis', scope); assert.ok(structure.requestCount > 1);
  f.failAt(3); await execute(f, structure); await settle(f); assert.equal(f.counts().text, 3);
  f.workflow = f.make(); const retry = await plan(f, 'analysis', { ...scope, retry: true });
  assert.equal(retry.reusedRequests, 1); assert.equal(retry.requestCount, structure.requestCount - 1);
  await execute(f, retry, { retryAcknowledged: true }); await settle(f);
  assert.equal(f.counts().text, structure.requestCount + 2); assert.equal((await plan(f, 'analysis', scope)).cached, true);
});

test('older same-source subtitles require explicit binding and can then be reused without uploading audio', async t => {
  const f = await fixture(t, { diskTranscript: true });
  const path = join(f.root, 'assets/live.vtt'); await writeFile(path, 'WEBVTT\n\n00:00.000 --> 00:01.500\n较早保存的同源字幕\n');
  await utimes(path, new Date('2020-01-01'), new Date('2020-01-01'));
  const status = await f.workflow.status(f.root, f.source.id);
  assert.equal((await plan(f, 'transcription')).enabled, false);
  await f.workflow.bindTranscript(f.root, { sourceId: f.source.id, sourceConfirmed: true, ...status.binding });
  assert.equal((await plan(f, 'transcription')).cached, true); assert.deepEqual(f.counts(), { asr: 0, text: 0 });
});

test('explicit new discovery batch after failure requires acknowledgment and does not resume old run', async t => {
  const f = await fixture(t); f.setTranscript({ cues: f.cues }); f.fail(true);
  await execute(f, await plan(f, 'discovery')); await settle(f);
  const oldRun = (await f.workflow.status(f.root, f.source.id)).discovery.runId;
  const next = await plan(f, 'discovery', { rerun: true, retry: true });
  assert.equal(next.retry, false); assert.equal(next.retryRequired, true); assert.equal(next.reusedRequests, 0);
  await assert.rejects(execute(f, next), { status: 409 }); f.fail(false);
  await execute(f, next, { retryAcknowledged: true }); await settle(f);
  assert.notEqual((await f.workflow.status(f.root, f.source.id)).discovery.runId, oldRun);
  assert.equal(f.counts().text, 2);
});

test('registering a plain video preserves previously saved private take identity and edited ranges', async t => {
  let saved, original;
  const f = await fixture(t, { beforeRegister: async root => {
    const sourceId = 'assets/live.mp4', version = await readSourceTakes(root, sourceId, sourceId);
    const document = { version: 1, sourceId, assetPath: sourceId, durationMs: 20000, signature: JSON.stringify([sourceId, 20000, []]), film: { tracks: [{ clips: [{ id: 'personal-take', src: sourceId, at: 2, time: [2, 4], attrs: { 'data-source-kind': 'context' } }] }] } };
    saved = { revision: 7, sourceIdentity: version.sourceIdentity, document }; original = JSON.stringify({ version: 1, sources: [saved] });
    await mkdir(join(root, '.film'), { recursive: true }); await writeFile(join(root, SOURCE_TAKES_FILE), original);
  } });
  assert.equal(f.source.id, 'assets/live.mp4');
  assert.deepEqual(await readSourceTakes(f.root, f.source.id, f.source.assetPath), saved);
  assert.equal(await readFile(join(f.root, SOURCE_TAKES_FILE), 'utf8'), original);
});

test('finished rerun confirmations cannot be replayed as another paid discovery or structure batch', async t => {
  const f = await fixture(t); f.setTranscript({ cues: f.cues }); await execute(f, await plan(f, 'discovery')); await settle(f);
  const rerun = await plan(f, 'discovery', { rerun: true }); await execute(f, rerun); await settle(f);
  f.workflow = f.make(); await assert.rejects(execute(f, rerun), { status: 409 }); assert.equal(f.counts().text, 2);
  const data = (await readProductAnalysis(f.root)).analysis, scope = { productId: data.products[0].id, intervalId: data.intervals[0].id, rerun: true };
  const structure = await plan(f, 'analysis', scope); await execute(f, structure); await settle(f);
  f.workflow = f.make(); await assert.rejects(execute(f, structure), { status: 409 }); assert.equal(f.counts().text, 3);
});

test('a failed explicit retry confirmation cannot be replayed after restart in any stage', async t => {
  const f = await fixture(t); f.failAsr(Error('uncertain audio'));
  await execute(f, await plan(f, 'transcription')); await settle(f);
  const audio = await plan(f, 'transcription', { retry: true }); await execute(f, audio, { retryAcknowledged: true }); await settle(f);
  f.workflow = f.make(); await assert.rejects(execute(f, audio, { retryAcknowledged: true }), { status: 409 }); assert.equal(f.counts().asr, 2);
  f.setTranscript({ cues: f.cues }); f.fail(true);
  await execute(f, await plan(f, 'discovery')); await settle(f);
  const split = await plan(f, 'discovery', { retry: true }); await execute(f, split, { retryAcknowledged: true }); await settle(f);
  f.workflow = f.make(); await assert.rejects(execute(f, split, { retryAcknowledged: true }), { status: 409 }); assert.equal(f.counts().text, 2);
  f.fail(false); await execute(f, await plan(f, 'discovery', { retry: true }), { retryAcknowledged: true }); await settle(f);
  const data = (await readProductAnalysis(f.root)).analysis, scope = { productId: data.products[0].id, intervalId: data.intervals[0].id };
  f.fail(true); await execute(f, await plan(f, 'analysis', scope)); await settle(f);
  const structure = await plan(f, 'analysis', { ...scope, retry: true }); await execute(f, structure, { retryAcknowledged: true }); await settle(f);
  f.workflow = f.make(); await assert.rejects(execute(f, structure, { retryAcknowledged: true }), { status: 409 }); assert.equal(f.counts().text, 5);
});

