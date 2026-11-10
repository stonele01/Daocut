import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSharedAnalysis, sharedHash } from './shared-analysis.mjs';
import { createStructurePlans, createStructurePlanInputReader } from './structure-plans.mjs';
import { importSharedProductTranscript } from './product-transcription.mjs';
import { analyzeTextStructure } from './text-structure.mjs';
import { ensureStructureDraft } from './structure-drafts.mjs';
import { filmHtml } from '../../src/film-doc.mjs';
import { readProjectFilm, editProjectFilm } from './film.mjs';
import { writeSourceSubtitles } from './subtitle-edits.mjs';
import { patchProjectSettings, readProjectSettings } from './project-settings.mjs';
import { createLiveAnalysis } from './live-analysis.mjs';
import { visualReviewCandidatesHash } from './product-visual-review.mjs';

const base = resolve(fileURLToPath(new URL('../../../..', import.meta.url)), '.tmp/structure-plans-tests');
function coordinator() {
  const tasks = new Map(); let counter = 0;
  return { tasks, coordinate: async (op, body) => {
    let task = tasks.get(body.taskKey);
    if (op === 'status') return { task: structuredClone(task ?? null) };
    if (op === 'claim') {
      if (task) return { acquired: false, task: structuredClone(task) };
      task = { taskKey: body.taskKey, inputHash: body.inputHash, attemptId: `attempt-${++counter}`, status: 'claimed' }; tasks.set(body.taskKey, task);
      return { acquired: true, task: structuredClone(task) };
    }
    assert.equal(task?.attemptId, body.attemptId);
    if (op === 'submitted') { const sendAllowed = task.status === 'claimed'; task.status = 'submitted'; return { sendAllowed, task: structuredClone(task) }; }
    if (op === 'complete') {
      if (task.status === 'complete') assert.deepEqual(task.result, body.result);
      task.status = 'complete'; task.result = body.result;
    }
    if (op === 'fail') task.status = 'uncertain';
    return { task: structuredClone(task) };
  } };
}
async function fixture(t, { publicSemantics = true, confirmedDependencies = true, completeSpeech = false, emptyCandidates = false, issues = [], mediaReview, visualReview } = {}) {
  await mkdir(base, { recursive: true }); const dir = await mkdtemp(join(base, 'plans-'));
  t.after(async () => { assert.ok(resolve(dir).startsWith(base + sep)); await rm(dir, { recursive: true, force: true }); });
  t.mock.method(globalThis, 'fetch', () => { throw Error('No real model or remote request'); });
  const roots = [join(dir, 'alice'), join(dir, 'bob')], resultRoot = join(dir, 'mock-nas');
  const source = { id: 'source', assetPath: 'assets/live.mp4', durationMs: 120000 };
  const scope = { sourceId: source.id, productId: 'product', intervalId: 'lecture', startMs: 0, endMs: 120000 };
  const cues = [{ startMs: 0, endMs: 10000, text: '完整钩子' }, { startMs: 10000, endMs: 25000, text: '完整核心卖点' }, { startMs: 25000, endMs: 40000, text: '完整购买指令' }];
  const candidates = completeSpeech ? (await analyzeTextStructure({ ...scope, rangeStartMs: scope.startMs, rangeEndMs: scope.endMs, cues, client: async () => ({
    schema: 'complete-speech-v1', candidates: [['痛点'], ['卖点'], ['福利机制', '行动指令']].map((tags, index) => ({ firstCue: index, lastCue: index, tags })), issues: [],
  }) })).candidates : cues.map((cue, n) => ({ ...cue, id: `candidate-${n}`, sourceId: source.id, productId: scope.productId, intervalId: scope.intervalId, cueRange: [n, n], tags: [['钩子'], ['卖点'], ['行动指令']][n], details: {}, origin: 'ai-text', version: 1 }));
  if (completeSpeech) publicSemantics = false;
  if (emptyCandidates) candidates.length = 0;
  const semanticReview = { version: 1, entries: candidates.map((c, n) => ({ candidateId: c.id, status: 'confirmed', roles: [['hook'], ['core'], ['purchase']][n], coreIds: n === 1 ? ['core-a'] : [], ...(confirmedDependencies ? { requires: [] } : {}), excludes: [], conditions: {} })) };
  const analysis = { version: 1, sources: [source], products: [{ id: 'product', name: '模拟商品', sourceIds: [source.id] }], intervals: [{ id: 'lecture', sourceId: source.id, productId: 'product', startMs: 0, endMs: 120000 }], candidates };
  const coord = coordinator(); let failPublication = false;
  const options = { coordinate: coord.coordinate, settings: () => ({ enabled: true, resultRoots: [{ libraryId: 'synthetic-library', root: resultRoot }] }), readManifest: async () => ({ items: { 'assets/live.mp4': { libraryId: 'synthetic-library', relativePath: 'live.mp4' } } }), resolveSource: async (root, asset) => join(root, asset), publishFile: async (path, bytes) => { if (failPublication) throw Error('simulated offline destination'); await writeFile(path, bytes); } };
  for (const root of roots) { await mkdir(join(root, 'assets'), { recursive: true }); await mkdir(join(root, '.film'), { recursive: true }); await writeFile(join(root, source.assetPath), 'synthetic original media'); await writeFile(join(root, 'film.html'), 'existing private film'); await writeFile(join(root, '.film/product-analysis.json'), JSON.stringify(analysis)); }
  const stores = roots.map(() => createSharedAnalysis(options));
  for (const root of roots) await importSharedProductTranscript(root, source, { cues, words: [] }, { schema: 'synthetic-transcript-v1', sha256: sharedHash(cues) });
  const original = await stores[0].prepare(roots[0], source, { action: 'analysis', scope, data: { cues, cueIndices: [0, 1, 2] } });
  const claim = await stores[0].acquire(original);
  await stores[0].complete(roots[0], original, claim.attemptId, { ...(completeSpeech ? { schema: 'complete-speech-v1' } : {}), candidates: candidates.map(c => ({ ...(publicSemantics ? { id: c.id } : {}), cueRange: c.cueRange, tags: c.tags, details: c.details })), ...(publicSemantics ? { semanticReview } : {}), version: 'fixture-v1', issues, ...(mediaReview ? { mediaReview } : {}), ...(visualReview ? { visualReview: typeof visualReview === 'function' ? visualReview(candidates) : visualReview } : {}) });
  const second = await stores[1].prepare(roots[1], source, { action: 'analysis', scope, data: { cues, cueIndices: [0, 1, 2] } });
  await stores[1].read(roots[1], second);
  const readInput = createStructurePlanInputReader();
  let calls = 0;
  const inspectInput = input => ({ inputHash: sharedHash({ scope: { startMs: input.scope.startMs, endMs: input.scope.endMs }, cues: input.cues, semanticReview: input.semanticReview }), issues: [], ready: true });
  const compose = async (_input, { cursor }) => { calls++; return { plans: [{ id: cursor ? 'plan-b' : 'plan-a', durationMs: 40000, segments: [] }], cursor: cursor ? null : { step: 1 }, complete: !!cursor, issues: [], stats: { visited: cursor ? 2 : 1 } }; };
  const make = (index, extra = {}) => createStructurePlans({ sharedAnalysis: stores[index], readInput, inspectInput, compose, rulesVersion: 'test-rules-v1', ...extra });
  return { roots, source, scope, analysis, cues, semanticReview, original, stores, options, coord, make, readInput, calls: () => calls, failPublication: value => { failPublication = value; }, request: { sourceId: source.id, productId: scope.productId, intervalId: scope.intervalId } };
}

test('public input reader verifies fixed analysis input and refuses private edits without publishing them', async t => {
  const f = await fixture(t);
  const input = await f.readInput(f.roots[0], f.request);
  assert.equal(input.visibility, 'shared'); assert.equal(input.engineInput.semanticReview.entries.length, 3);
  const changed = structuredClone(f.analysis); changed.candidates[1].text = '个人改过的卖点';
  await writeFile(join(f.roots[0], '.film/product-analysis.json'), JSON.stringify(changed));
  const privateInput = await f.readInput(f.roots[0], f.request);
  assert.equal(privateInput.visibility, 'private');
  const blocked = await f.make(0).generate(f.roots[0], f.request);
  assert.equal(blocked.status, 'unavailable'); assert.equal(f.calls(), 0); assert.equal(f.coord.tasks.size, 1);
});

test('saved public media checks are reused across projects without entering body enumeration', async t => {
  const mediaReview = { version: 'product-media-review-v1', key: 'a'.repeat(64), sourceSha: 'b'.repeat(64), status: 'complete',
    scope: { startMs: 0, endMs: 120000 }, speechVerified: false, continuousActionVerified: false, issues: [],
    segments: [{ startMs: 10000, endMs: 25000, cueRange: [1,1], visual: { status: 'sampled', sampleTimesMs: [12000] },
      audio: { status: 'technical-checked', hasAudio: true, peakDb: -8, integratedLufs: -20, measurementRange: { startMs: 0, endMs: 120000 } }, issues: [] }] };
  const f = await fixture(t, { mediaReview });
  const input = await f.readInput(f.roots[0], f.request);
  assert.deepEqual(input.mediaReview, mediaReview);
  assert.equal(input.mediaReviewOrigin, 'shared');
  assert.equal(input.engineInput.mediaReview, undefined, 'technical evidence never changes ordering/eligibility');
  const baseline = await readFile(join(f.roots[0], '.film/shared-analysis', `${f.original.taskKey}.json`), 'utf8');
  const options = { inspectInput: undefined, compose: undefined, rulesVersion: undefined };
  const original = await f.make(0, options).generate(f.roots[0], f.request);
  const reused = await f.make(1, options).generate(f.roots[1], f.request);
  assert.deepEqual(original.mediaReview, mediaReview);
  assert.deepEqual(reused.mediaReview, mediaReview);
  assert.deepEqual(reused.plans, original.plans);
  const withoutReview = createStructurePlans({ sharedAnalysis: f.stores[0], readInput: async (...args) => {
    const value = await f.readInput(...args); delete value.mediaReview; delete value.mediaReviewOrigin; return value;
  } });
  const unchanged = await withoutReview.status(f.roots[0], f.request);
  assert.equal(unchanged.taskKey, original.taskKey);
  assert.deepEqual(unchanged.plans, original.plans);
  assert.equal(await readFile(join(f.roots[0], '.film/shared-analysis', `${f.original.taskKey}.json`), 'utf8'), baseline);
});

test('explicit local media supplement is reused without changing public baseline, plans or another project', async t => {
  const f = await fixture(t, { completeSpeech: true });
  const publicFile = join(f.roots[0], '.film/shared-analysis', `${f.original.taskKey}.json`);
  const publicBytes = await readFile(publicFile, 'utf8'), baseline = JSON.parse(publicBytes);
  const mediaReview = { version: 'product-media-review-v1', key: 'c'.repeat(64), sourceSha: 'd'.repeat(64), status: 'complete',
    scope: { startMs: 0, endMs: 120000 }, speechVerified: false, continuousActionVerified: false, issues: [], segments: [] };
  let calls = 0;
  const live = createLiveAnalysis({ structureVersion: 'fixture-v1', probeSource: async () => ({ duration: 120 }),
    modelClient: async () => assert.fail('supplement must not resubmit text'),
    mediaReview: async () => { calls++; return mediaReview; } });
  await live.importShared(f.roots[0], f.source.id, f.scope, baseline.snapshot.payload, baseline.result, { adopt: true });
  const service = f.make(0, { inspectInput: undefined, compose: undefined, rulesVersion: undefined });
  const before = await service.generate(f.roots[0], f.request);
  assert.equal(before.status, 'complete');
  assert.equal(before.mediaReview, undefined);
  await live.reviewMedia(f.roots[0], { ...f.scope, confirmed: true });
  const after = await service.status(f.roots[0], f.request);
  assert.equal(calls, 1);
  assert.deepEqual(after.mediaReview, mediaReview);
  assert.equal(after.mediaReviewOrigin, 'local');
  assert.equal(after.taskKey, before.taskKey);
  assert.deepEqual(after.plans, before.plans);
  const other = await f.make(1, { inspectInput: undefined, compose: undefined, rulesVersion: undefined }).generate(f.roots[1], f.request);
  assert.equal(other.mediaReview, undefined);
  assert.deepEqual(other.plans.map(plan => plan.id), before.plans.map(plan => plan.id));
  assert.equal(await readFile(publicFile, 'utf8'), publicBytes);
  for (const root of f.roots) assert.equal(await readFile(join(root, 'film.html'), 'utf8'), 'existing private film');
});

const visualRecord = candidates => ({ version: 'product-visual-review-v1', status: 'complete', key: 'e'.repeat(64), sourceSha: 'f'.repeat(64), candidatesHash: visualReviewCandidatesHash(candidates),
  scope: { startMs: 0, endMs: 120000 }, continuousActionVerified: false, speechVerified: false, issues: [],
  entries: [{ startMs: 10000, endMs: 25000, cueRange: [1, 1], productMatch: 'match', display: 'shown', evidenceTimesMs: [12000], observation: '模拟抽帧中可见商品包装', issues: [] }] });

test('saved public visual evidence is reused without changing plan identity or body order', async t => {
  const f = await fixture(t, { visualReview: visualRecord });
  const input = await f.readInput(f.roots[0], f.request), expected = visualRecord(f.analysis.candidates);
  assert.deepEqual(input.visualReview, expected); assert.equal(input.visualReviewOrigin, 'shared');
  assert.equal(input.engineInput.visualReview, undefined, 'visual conclusions do not silently change body enumeration');
  const options = { inspectInput: undefined, compose: undefined, rulesVersion: undefined };
  const first = await f.make(0, options).generate(f.roots[0], f.request);
  const other = await f.make(1, options).generate(f.roots[1], f.request);
  assert.deepEqual(first.visualReview, expected); assert.deepEqual(other.visualReview, expected);
  assert.deepEqual(other.plans, first.plans);
  const noEvidence = createStructurePlans({ sharedAnalysis: f.stores[0], readInput: async (...args) => { const value = await f.readInput(...args); delete value.visualReview; delete value.visualReviewOrigin; return value; } });
  const without = await noEvidence.status(f.roots[0], f.request);
  assert.equal(without.taskKey, first.taskKey); assert.deepEqual(without.plans, first.plans);
});

test('local visual supplements require current run and candidate hash and never alter a shared baseline', async t => {
  const f = await fixture(t), root = f.roots[0];
  const publicFile = join(root, '.film/shared-analysis', `${f.original.taskKey}.json`), publicBytes = await readFile(publicFile, 'utf8');
  const baseline = JSON.parse(publicBytes), visualReview = visualRecord(f.analysis.candidates);
  const state = { currentRunId: 'run-1', sharedRef: baseline.result, localVisualReview: true, visualReviewForRun: 'run-1', visualReviewCandidatesHash: visualReview.candidatesHash, visualReview };
  await mkdir(join(root, '.film/live-analysis'), { recursive: true });
  const liveFile = join(root, '.film/live-analysis', `${sharedHash(f.source.id)}.json`);
  const saveLive = async () => writeFile(liveFile, JSON.stringify({ analyses: { lecture: state } }));
  await saveLive();
  const input = await f.readInput(root, f.request);
  assert.deepEqual(input.visualReview, visualReview); assert.equal(input.visualReviewOrigin, 'local');
  state.visualReview.productName = '更名前商品'; await saveLive();
  const renamedLocal = await f.readInput(root, f.request);
  assert.deepEqual(renamedLocal.visualReview, state.visualReview);
  assert.equal(renamedLocal.visualReviewStale, true, 'local evidence for another product name remains visible but historical');
  assert.equal((await f.readInput(f.roots[1], f.request)).visualReview, undefined, 'local supplements do not spread to colleagues');
  state.visualReviewForRun = 'old-run'; await saveLive();
  assert.equal((await f.readInput(root, f.request)).visualReview, undefined, 'old-run evidence is not reused');
  state.visualReviewForRun = 'run-1'; state.visualReviewCandidatesHash = '0'.repeat(64); await saveLive();
  assert.equal((await f.readInput(root, f.request)).visualReview, undefined, 'changed candidate boundaries/text invalidate supplementary evidence');
  delete state.visualReviewCandidatesHash; await saveLive();
  assert.deepEqual((await f.readInput(root, f.request)).visualReview, visualReview, 'record hash is compatible when sidecar hash is absent');
  assert.equal(await readFile(publicFile, 'utf8'), publicBytes);
  assert.equal(await readFile(join(root, 'film.html'), 'utf8'), 'existing private film');
});

test('public visual evidence with an old product name stays visible as stale without changing plans', async t => {
  const f = await fixture(t, { visualReview: candidates => ({ ...visualRecord(candidates), productName: '更名前商品' }) });
  const input = await f.readInput(f.roots[0], f.request);
  assert.equal(input.visualReview.productName, '更名前商品');
  assert.equal(input.visualReviewStale, true);
  const result = await f.make(0, { inspectInput: undefined, compose: undefined, rulesVersion: undefined }).generate(f.roots[0], f.request);
  assert.equal(result.visualReviewStale, true); assert.equal(result.visualReviewOrigin, 'shared');
  assert.equal(result.plans.length, 1);
});

test('one shared generator persists its cursor on reopen; another reads complete results without recomputing', async t => {
  const f = await fixture(t), first = f.make(0), second = f.make(1);
  assert.equal((await first.status(f.roots[0], f.request)).status, 'idle');
  const a = await first.generate(f.roots[0], f.request); assert.equal(a.status, 'running'); assert.equal(a.plans.length, 1);
  const b = await second.generate(f.roots[1], f.request); assert.equal(b.status, 'busy'); assert.equal(f.calls(), 1);
  const finished = await f.make(0).generate(f.roots[0], f.request);
  assert.equal(finished.status, 'complete'); assert.equal(finished.plans.length, 2); assert.equal(f.calls(), 2);
  const reused = await second.generate(f.roots[1], f.request);
  assert.equal(reused.status, 'complete'); assert.deepEqual(reused.plans, finished.plans); assert.equal(f.calls(), 2);
  assert.deepEqual((await f.make(0).generate(f.roots[0], f.request)).plans, finished.plans); assert.equal(f.calls(), 2);
  for (const root of f.roots) assert.equal(await readFile(join(root, 'film.html'), 'utf8'), 'existing private film');
});

test('failed result publication retains plans and explicit outbox recovery never reruns the engine', async t => {
  const f = await fixture(t), service = f.make(0);
  await service.generate(f.roots[0], f.request); f.failPublication(true);
  const pending = await service.generate(f.roots[0], f.request);
  assert.equal(pending.status, 'publish-pending'); assert.equal(pending.plans.length, 2); assert.equal(f.calls(), 2);
  assert.equal((await f.make(0).generate(f.roots[0], f.request)).status, 'publish-pending'); assert.equal(f.calls(), 2);
  f.failPublication(false);
  const recovered = await f.make(0).publish(f.roots[0], { sourceId: f.source.id, taskKey: pending.taskKey, confirmed: true });
  assert.equal(recovered.status, 'complete'); assert.equal(f.calls(), 2);
});

test('missing public semantic review is reported without turning private sidecar edits into public data', async t => {
  const f = await fixture(t), input = await f.readInput(f.roots[0], f.request);
  const unavailable = f.make(0, { readInput: async () => ({ ...input, visibility: 'private', issues: [{ code: 'PRIVATE_SEMANTICS', message: '个人语义核对只留本机' }] }) });
  assert.equal((await unavailable.generate(f.roots[0], f.request)).status, 'unavailable'); assert.equal(f.calls(), 0);
  assert.equal(f.coord.tasks.size, 1);
});

test('default local engine produces a 40 second public plan with exact quotes and source coordinates', async t => {
  const f = await fixture(t), service = f.make(0, { inspectInput: undefined, compose: undefined, rulesVersion: undefined });
  const result = await service.generate(f.roots[0], f.request);
  assert.equal(result.status, 'complete'); assert.equal(result.complete, true); assert.equal(result.allValidCombinationsEnumerated, true);
  assert.equal(result.plans.length, 1); assert.equal(result.plans[0].durationMs, 40000);
  assert.deepEqual(result.plans[0].clips.map(c => c.text), f.cues.map(c => c.text));
  assert.ok(result.plans[0].clips.every(c => c.sourceId === f.source.id));
  assert.ok(result.plans[0].clips.every(c => c.assetPath === f.source.assetPath));
  const publicRecord = f.coord.tasks.get(result.taskKey);
  const envelope = JSON.parse(await readFile(join(f.roots[0], '.film/shared-analysis', `${result.taskKey}.json`), 'utf8'));
  assert.equal(envelope.result.sha256, publicRecord.result.sha256);
  assert.ok(envelope.snapshot.payload.plans[0].clips.every(c => c.assetPath === undefined));
  assert.equal(f.calls(), 0);
});

test('a saved completed batch recovers even if outbox creation was interrupted, without re-enumeration', async t => {
  const f = await fixture(t); let interrupted = true;
  const shared = { ...f.stores[0], complete: async (...args) => { if (interrupted) throw Error('simulated before outbox write'); return f.stores[0].complete(...args); } };
  const service = f.make(0, { sharedAnalysis: shared });
  await service.generate(f.roots[0], f.request);
  const pending = await service.generate(f.roots[0], f.request);
  assert.equal(pending.status, 'publish-pending'); assert.equal(f.calls(), 2);
  interrupted = false;
  const recovered = await f.make(0).publish(f.roots[0], { sourceId: f.source.id, taskKey: pending.taskKey, confirmed: true });
  assert.equal(recovered.status, 'complete'); assert.equal(f.calls(), 2);
});

test('actual missing semantic metadata stays unavailable and never claims a generation task', async t => {
  const f = await fixture(t, { publicSemantics: false });
  const service = f.make(0, { inspectInput: undefined, compose: undefined, rulesVersion: undefined });
  const state = await service.generate(f.roots[0], f.request);
  assert.equal(state.status, 'unavailable'); assert.ok(state.issues.some(item => item.code === 'SEMANTICS_UNREVIEWED'));
  assert.equal(f.coord.tasks.size, 1); assert.equal(f.calls(), 0);
});

test('public review missing dependency confirmation is not converted to confirmed independence', async t => {
  const f = await fixture(t, { confirmedDependencies: false });
  const service = f.make(0, { inspectInput: undefined, compose: undefined, rulesVersion: undefined });
  const state = await service.generate(f.roots[0], f.request);
  assert.equal(state.status, 'unavailable'); assert.ok(state.issues.some(item => item.code === 'DEPENDENCIES_UNREVIEWED'));
  assert.equal(f.coord.tasks.size, 1);
});

test('simultaneous independent projects admit one generator', async t => {
  const f = await fixture(t);
  const states = await Promise.all([f.make(0).generate(f.roots[0], f.request), f.make(1).generate(f.roots[1], f.request)]);
  assert.deepEqual(states.map(s => s.status).sort(), ['busy', 'running']);
  assert.equal(f.calls(), 1); assert.equal(f.coord.tasks.size, 2);
});

test('public plan identity survives different local source, product, lecture and candidate IDs', async t => {
  const f = await fixture(t), original = f.make(0, { inspectInput: undefined, compose: undefined, rulesVersion: undefined });
  const complete = await original.generate(f.roots[0], f.request);
  const changed = structuredClone(f.analysis), sourceId = 'source-b', productId = 'product-b', intervalId = 'lecture-b';
  changed.sources[0].id = sourceId; changed.products[0].id = productId; changed.products[0].sourceIds = [sourceId];
  Object.assign(changed.intervals[0], { id: intervalId, sourceId, productId });
  changed.candidates.forEach((c, n) => Object.assign(c, { id: `local-b-${n}`, sourceId, productId, intervalId }));
  await writeFile(join(f.roots[1], '.film/product-analysis.json'), JSON.stringify(changed));
  await importSharedProductTranscript(f.roots[1], changed.sources[0], { cues: f.cues, words: [] }, { schema: 'synthetic-transcript-v1', sha256: sharedHash(f.cues) });
  const path = join(f.roots[1], '.film/shared-analysis', `${f.original.taskKey}.json`), saved = JSON.parse(await readFile(path, 'utf8'));
  saved.sourceId = sourceId; saved.descriptor.sourceId = sourceId; saved.descriptor.localScope = { ...f.scope, sourceId, productId, intervalId };
  await writeFile(path, JSON.stringify(saved));
  const other = f.make(1, { inspectInput: undefined, compose: () => { throw Error('Must reuse'); }, rulesVersion: undefined });
  const reused = await other.generate(f.roots[1], { sourceId, productId, intervalId });
  assert.equal(reused.status, 'complete'); assert.equal(reused.plans[0].id, complete.plans[0].id); assert.equal(reused.taskKey, complete.taskKey);
  assert.ok(reused.plans[0].clips.every(c => c.sourceId === sourceId && c.candidateId.startsWith('local-b-')));
});

test('compact analysis survives shared reuse, private edits and reopening without changing the public baseline or parent film', async t => {
  const f = await fixture(t, { completeSpeech: true });
  const parent = f.roots[0];
  await writeFile(join(parent, '.film/id'), 'complete-speech-parent');
  await writeFile(join(parent, 'film.html'), filmHtml({ tracks: [{ clips: [{ id: 'existing-film', src: f.source.assetPath, time: [1, 2] }] }] }));
  const paths = ['film.html', 'assets/live.mp4', '.film/product-analysis.json', `.film/shared-analysis/${f.original.taskKey}.json`];
  const protectedBefore = await Promise.all(paths.map(path => readFile(join(parent, path), 'utf8')));
  const service = f.make(0, { inspectInput: undefined, compose: undefined, rulesVersion: undefined });
  const result = await service.generate(parent, f.request);
  assert.equal(result.status, 'complete');
  assert.ok(result.plans.length >= 2);
  assert.ok(result.plans.some(plan => plan.clips[0].text === '完整核心卖点'));
  assert.ok(result.plans.every(plan => plan.clips.slice(0, -1).every(clip => !clip.roles.includes('purchase'))));
  assert.ok(result.plans.every(plan => plan.clips[0].roles.includes('hook')));
  const [aPlan, bPlan] = result.plans;
  const a = await ensureStructureDraft(parent, { parentProjectId: 'complete-speech-parent', plan: aPlan });
  const b = await ensureStructureDraft(parent, { parentProjectId: 'complete-speech-parent', plan: bPlan });
  const bFilm = await readFile(join(b.root, 'film.html'), 'utf8');
  const film = await readProjectFilm(a.root), first = film.value.tracks[0].clips[0];
  await editProjectFilm(a.root, film.rev, [{ op: 'set', clip: first.id, field: 'time', value: [first.time[0] + 0.5, first.time[1]] }]);
  await writeSourceSubtitles(a.root, f.source.assetPath, [{ startMs: 1000, endMs: 2000, text: '仅A草稿的个人字幕' }]);
  await patchProjectSettings(a.root, { fps: 24 });
  const edited = await readFile(join(a.root, 'film.html'), 'utf8');
  const reused = await f.make(1, { inspectInput: undefined, compose: () => { throw Error('Existing public result must be reused'); }, rulesVersion: undefined }).generate(f.roots[1], f.request);
  assert.deepEqual(reused.plans, result.plans);
  const reopened = await ensureStructureDraft(parent, { parentProjectId: 'complete-speech-parent', plan: aPlan });
  assert.equal(reopened.root, a.root);
  assert.equal(await readFile(join(a.root, 'film.html'), 'utf8'), edited);
  assert.match(await readFile(join(a.root, 'assets/live.vtt'), 'utf8'), /仅A草稿的个人字幕/);
  assert.equal((await readProjectSettings(a.root)).fps, 24);
  assert.equal(await readFile(join(b.root, 'film.html'), 'utf8'), bFilm);
  assert.deepEqual(await Promise.all(paths.map(path => readFile(join(parent, path), 'utf8'))), protectedBefore);
  assert.equal(f.calls(), 0);
});

test('shared compact analysis retains unread-material issues while ordinary ASR evidence notes do not block text enumeration', async t => {
  for (const unread of [false, true]) {
    const f = await fixture(t, { completeSpeech: true, issues: ['未检查原音及画面', ...(unread ? ['本段后半未读'] : [])] });
    const result = await f.make(0, { inspectInput: undefined, compose: undefined, rulesVersion: undefined }).generate(f.roots[0], f.request);
    assert.equal(result.complete, true);
    assert.equal(result.allValidCombinationsEnumerated, !unread);
    assert.equal(result.issues.some(issue => issue.message === '本段后半未读'), unread);
  }
});

test('an empty compact analysis still displays its actual failure reason instead of only missing labels', async t => {
  const f = await fixture(t, { completeSpeech: true, emptyCandidates: true, issues: ['本段转写归属无法确认，未生成候选'] });
  const result = await f.make(0, { inspectInput: undefined, compose: undefined, rulesVersion: undefined }).generate(f.roots[0], f.request);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.plans.length, 0);
  assert.ok(result.issues.some(issue => issue.code === 'ANALYSIS_INCOMPLETE' && issue.message.includes('转写归属无法确认')));
});
