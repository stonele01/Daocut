import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createLiveAnalysis } from './live-analysis.mjs';
import { readProductAnalysis, writeProductAnalysis } from './product-analysis.mjs';
import { TEXT_STRUCTURE_PROMPT, TEXT_STRUCTURE_VERSION } from './text-structure.mjs';

const probe = async () => ({ duration: 100 });
const scope = { sourceId: 's', productId: 'p', intervalId: 'first', startMs: 10000, endMs: 18000, lectureOnly: true };
const cues = Array.from({ length: 7 }, (_, index) => ({ text: `${index}${'这是模拟的完整卖点话术。'.repeat(25)}`, startMs: 10000 + index * 1000, endMs: 10500 + index * 1000 }));
const outside = { text: '这是另一次返场的句子', startMs: 30000, endMs: 32000 };
const policy = { maxInputBytes: Buffer.byteLength(TEXT_STRUCTURE_PROMPT) + 2200, contextCues: 1 };
const compact = body => ({ schema: 'complete-speech-v1', candidates: JSON.parse(body).cues.map((_, index) => ({ firstCue: index, lastCue: index, tags: ['卖点'] })), issues: [] });

async function setup(t) {
  const base = resolve(tmpdir()), root = await mkdtemp(join(base, 'daocut-compact-analysis-'));
  t.after(async () => { assert.ok(resolve(root).startsWith(`${base}${sep}`)); await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'assets/source.mp4'), 'synthetic source; no media service');
  await writeFile(join(root, 'film.html'), 'existing film must remain unchanged');
  await writeProductAnalysis(root, { version: 1, sources: [{ id: 's', assetPath: 'assets/source.mp4', durationMs: 100000 }], products: [{ id: 'p', name: '模拟商品', sourceIds: ['s'] }], intervals: [
    { id: 'first', sourceId: 's', productId: 'p', startMs: 10000, endMs: 18000 },
    { id: 'return', sourceId: 's', productId: 'p', startMs: 30000, endMs: 33000 },
  ], candidates: [] }, probe);
  return { root, options: { modelIdentity: 'isolated-compact-mock', probeSource: probe, transcribe: async () => assert.fail('must reuse saved transcription'), readTranscript: async () => ({ cues: [...cues, outside] }), structureWindowPolicy: policy } };
}

async function analyze(route, root, body = {}) {
  await route.startAnalysis(root, { ...scope, ...body });
  await route.wait(root, 's');
  return route.view(root, 's', 'first', 'p', scope);
}

test('compact windows resume without rebilling completed output and preserve the contract through shared import', async t => {
  const c = await setup(t), calls = [];
  let interrupt = true;
  const modelClient = async ({ input }) => {
    const first = Number(JSON.parse(input).cues[0].text[0]); calls.push(first);
    assert.ok(JSON.parse(input).cues.every(cue => cue.endMs <= scope.endMs), 'return lecture is excluded');
    if (interrupt && calls.length === 2) throw Object.assign(Error('simulated interruption'), { code: 'MODEL_TIMEOUT' });
    return compact(input);
  };
  let route = createLiveAnalysis({ ...c.options, modelClient });
  const failed = await analyze(route, c.root);
  assert.equal(failed.analysis.status, 'failed');
  assert.equal(failed.analysis.progress.completedWindows, 1);
  assert.equal((await readProductAnalysis(c.root)).analysis.candidates.length, 0);
  interrupt = false;
  route = createLiveAnalysis({ ...c.options, modelClient });
  await route.view(c.root, 's', 'first', 'p', scope);
  assert.equal(calls.length, 2, 'opening the project does not retry');
  const done = await analyze(route, c.root, { retryFailed: true });
  assert.equal(done.analysis.status, 'complete');
  assert.equal(done.analysis.progress.resumedWindows, 1);
  assert.equal(calls.filter(first => first === 0).length, 1);
  const candidates = (await readProductAnalysis(c.root)).analysis.candidates;
  assert.equal(candidates.length, cues.length);
  assert.ok(candidates.every(candidate => candidate.details.composition.contract === 'complete-speech-v1'));
  assert.equal(new Set(candidates.map(candidate => candidate.details.composition.coreIds[0])).size, cues.length);
  const payload = await route.exportShared(c.root, 's', 'first');
  const receiver = await setup(t); let requests = 0;
  const reused = createLiveAnalysis({ ...receiver.options, modelClient: async () => { requests++; assert.fail('shared import must not request model'); } });
  const sharedRef = { sha256: 'a'.repeat(64) };
  await reused.importShared(receiver.root, 's', scope, payload, sharedRef);
  const imported = (await readProductAnalysis(receiver.root)).analysis.candidates;
  assert.deepEqual(imported.map(candidate => candidate.details.composition), candidates.map(candidate => candidate.details.composition));
  assert.deepEqual(imported.map(candidate => candidate.text), cues.map(cue => cue.text));
  await analyze(reused, receiver.root);
  assert.equal(requests, 0);
  assert.equal(await readFile(join(c.root, 'film.html'), 'utf8'), 'existing film must remain unchanged');
  assert.equal(await readFile(join(receiver.root, 'film.html'), 'utf8'), 'existing film must remain unchanged');
});

test('legacy shared output remains reusable after prompt changes without inventing compact semantics', async t => {
  const c = await setup(t); let requests = 0;
  const options = { ...c.options, modelClient: async () => { requests++; assert.fail('old public result must not be rerun'); } };
  const old = createLiveAnalysis({ ...options, structurePrompt: 'old stored prompt' });
  const details = { subtypes: [], reason: '旧版记录', evidence: ['ASR'], context: '', repetition: '', review: [] };
  const payload = { version: TEXT_STRUCTURE_VERSION, candidates: [{ cueRange: [0, 0], tags: ['价格锚点'], details }], issues: [] };
  await old.importShared(c.root, 's', scope, payload, { sha256: 'b'.repeat(64) });
  const before = await readFile(join(c.root, '.film/product-analysis.json'), 'utf8');
  const current = createLiveAnalysis(options);
  const state = await analyze(current, c.root);
  assert.equal(state.analysis.status, 'complete');
  assert.equal(state.analysis.stale, false);
  assert.equal(requests, 0);
  assert.equal(await readFile(join(c.root, '.film/product-analysis.json'), 'utf8'), before);
  const candidate = (await readProductAnalysis(c.root)).analysis.candidates[0];
  assert.equal(candidate.details.composition, undefined);
  assert.deepEqual(candidate.tags, ['价格锚点']);
});

test('shared export preserves pending conflicts discovered while merging compact windows', async t => {
  const c = await setup(t);
  const route = createLiveAnalysis({ ...c.options, modelClient: async ({ input }) => {
    const result = compact(input), first = JSON.parse(input).cues[0].text[0];
    for (const candidate of result.candidates) candidate.conditions = { offerRound: first };
    return result;
  } });
  assert.equal((await analyze(route, c.root)).analysis.status, 'complete');
  const stored = (await readProductAnalysis(c.root)).analysis.candidates;
  const pending = stored.filter(candidate => candidate.details.composition.status === 'pending');
  assert.ok(pending.length, 'overlapping windows must expose their contradictory condition');
  const payload = await route.exportShared(c.root, 's', 'first');
  for (const candidate of pending) {
    const exported = payload.candidates.find(item => JSON.stringify(item.cueRange) === JSON.stringify(candidate.cueRange));
    assert.deepEqual(exported.details.composition, candidate.details.composition);
    assert.deepEqual(exported.details.review, candidate.details.review);
  }
});

test('zero-candidate compact windows retain schema and unread issues on resume, publication and import', async t => {
  const c = await setup(t), calls = [];
  let interrupt = true;
  const modelClient = async ({ input }) => {
    const first = Number(JSON.parse(input).cues[0].text[0]); calls.push(first);
    if (interrupt && calls.length === 2) throw Object.assign(Error('simulated interruption'), { code: 'MODEL_TIMEOUT' });
    return { schema: 'complete-speech-v1', candidates: [], issues: first === 0 ? ['模拟第一窗口有未读材料'] : [] };
  };
  let route = createLiveAnalysis({ ...c.options, modelClient });
  assert.equal((await analyze(route, c.root)).analysis.status, 'failed');
  interrupt = false;
  route = createLiveAnalysis({ ...c.options, modelClient });
  const done = await analyze(route, c.root, { retryFailed: true });
  assert.equal(done.analysis.status, 'complete');
  assert.equal(done.analysis.candidateCount, 0);
  assert.equal(done.analysis.schema, 'complete-speech-v1');
  assert.equal(calls.filter(first => first === 0).length, 1);
  const payload = await route.exportShared(c.root, 's', 'first');
  assert.equal(payload.schema, 'complete-speech-v1');
  assert.ok(payload.issues.includes('模拟第一窗口有未读材料'));
  const receiver = await setup(t);
  const reused = createLiveAnalysis({ ...receiver.options, modelClient: async () => assert.fail('zero-candidate shared import must not rerun') });
  const imported = await reused.importShared(receiver.root, 's', scope, payload, { sha256: 'c'.repeat(64) });
  assert.equal(imported.analysis.schema, 'complete-speech-v1');
  assert.ok(imported.analysis.issues.includes('模拟第一窗口有未读材料'));
  const reopened = await analyze(reused, receiver.root);
  assert.equal(reopened.analysis.schema, 'complete-speech-v1');
  assert.equal(reopened.analysis.candidateCount, 0);
});
