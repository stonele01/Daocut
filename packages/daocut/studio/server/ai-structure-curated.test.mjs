import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createAiStructurePlans } from './ai-structure-plans.mjs';
import { aiStructurePrompt, createAiStructureRequest as requestForVersion, validateAiStructureResponse } from './ai-structure.mjs';
import { inspectAiCuratedInput, OPENING_SELECTION_VERSION, getAiCuratedCoverage } from './ai-structure-curated.mjs';
import { inspectAiVariantsInput, validateAiStructureVariants } from './ai-structure-variants.mjs';
import { sharedHash } from './shared-analysis.mjs';
import { analyzeTextStructure, combineTextStructureWindows, TEXT_STRUCTURE_PROMPT, createDeepSeekTextClient } from './text-structure.mjs';
import { createDesktopAnalysisServices } from './desktop-analysis-services.mjs';

function fixture(count = 50, selected = count) {
  const scope = { sourceId: 's', productId: 'p', intervalId: 'i', startMs: 0, endMs: (count + 1) * 15000 };
  const cues = Array.from({ length: count + 1 }, (_, n) => ({ text: `模拟完整话术${n}`, startMs: n * 15000, endMs: n * 15000 + 13000 }));
  const candidates = cues.map((cue, n) => ({ ...scope, ...cue, id: `speech-${n}`, cueRange: [n, n], tags: [],
    details: { review: ['仅依据 ASR；画面、声音和句级边界待核实'], composition: {
      contract: 'complete-speech-v1', status: 'confirmed', roles: n < 3 ? ['intro', 'core', 'price'] : [n === count ? 'purchase' : 'pain'], ...(n < 3 ? { price: { kind: 'current', evidence: [0] } } : {}), requires: [], excludes: [], conditions: {},
      openingPolicy: OPENING_SELECTION_VERSION, ...(n < selected ? { opening: { group: `诉求${n}`, followup: `回应诉求${n}` } } : {}),
    } } }));
  return { source: { id: 's', assetPath: 'assets/mock.mp4' }, scope, context: scope, visibility: 'local', analysisVersion: 'analysis', semanticVersion: 'semantic',
    engineInput: { scope, sourceIdentity: 'mock', candidates, cues }, issues: [] };
}
const sequence = (f, id) => [id, id === 'speech-0' ? 'speech-1' : 'speech-0', f.engineInput.candidates.at(-1).id];
const response = plans => ({ schema: AI_STRUCTURE_VERSION, plans });
const currentResponse = plans => ({ schema: 'ai-structure-plans-v8', prices: [0, 1, 2].map(n => ({ id: `speech-${n}`, kind: 'current', evidence: [n] })), plans });
const review = (f, n) => f.engineInput.candidates[n].details.composition;
const AI_STRUCTURE_VERSION = 'ai-structure-plans-v7';
const createAiStructureRequest = (input, options = {}) => requestForVersion(input, { version: AI_STRUCTURE_VERSION, ...options });
const base = resolve(import.meta.dirname, '../../../../.tmp/curated-tests');
async function rootFor(t) {
  await mkdir(base, { recursive: true }); const root = await mkdtemp(join(base, 'case-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.mock.method(globalThis, 'fetch', () => { throw Error('Network forbidden'); });
  return root;
}

test('selection preserves the full catalog, supports 35 and 50 targets, and never fills a shortage with unselected material', () => {
  for (const selected of [0, 3, 35, 50]) {
    const f = fixture(50, selected), inspected = inspectAiCuratedInput(f.engineInput);
    assert.equal(inspected.openingIds.length, selected); assert.equal(inspected.ready, selected > 0);
    assert.equal(inspected.reviewItems.length, 51);
    if (selected) { const body = JSON.parse(createAiStructureRequest(f).input); assert.equal(body.units.length, 51); assert.equal(body.openingIds.length, selected); }
  }
  assert.match(TEXT_STRUCTURE_PROMPT, /至少35个/); assert.match(TEXT_STRUCTURE_PROMPT, /35不是上限/);
  assert.match(TEXT_STRUCTURE_PROMPT, /35不是每个窗口的配额/);
});

test('same-meaning duplicate openings do not delete body material and selection changes only the v6 identity', () => {
  const f = fixture(), legacy = inspectAiVariantsInput(f.engineInput).inputHash, before = inspectAiCuratedInput(f.engineInput).inputHash;
  review(f, 1).opening.group = review(f, 0).opening.group;
  assert.equal(inspectAiCuratedInput(f.engineInput).openingIds.length, 49);
  assert.notEqual(inspectAiCuratedInput(f.engineInput).inputHash, before);
  assert.equal(inspectAiVariantsInput(f.engineInput).inputHash, legacy);
  assert.equal(JSON.parse(createAiStructureRequest(f).input).units.length, 51);
  review(f, 2).requires = ['speech-3'];
  assert.ok(!inspectAiCuratedInput(f.engineInput).openingIds.includes('speech-2'));
});

test('first generation omits history and stale visual failures; follow-up includes only relevant history behind a stable full catalog', () => {
  const f = fixture(50, 35); f.visualReview = { status: 'failed', issues: ['OLD FAILED VISION'] }; f.visualReviewStale = true;
  const first = createAiStructureRequest(f), body = JSON.parse(first.input);
  assert.deepEqual(Object.keys(body), ['rules', 'units', 'openingIds']);
  assert.ok(!first.input.includes('OLD FAILED VISION')); assert.ok(!first.input.includes('画面、声音'));
  assert.ok(body.units.every(unit => !Object.hasOwn(unit, 'startMs') && !Object.hasOwn(unit, 'requires')));
  const followup = createAiStructureRequest(f, { openingIds: ['speech-0'], previous: [sequence(f, 'speech-0'), sequence(f, 'speech-1')] });
  assert.deepEqual(JSON.parse(followup.input).previous, [sequence(f, 'speech-0')]);
  assert.equal(first.input.split(',"openingIds":')[0], followup.input.split(',"openingIds":')[0]);
  assert.throws(() => createAiStructureRequest(f, { openingIds: ['speech-40'] }), { code: 'AI_STRUCTURE_INVALID_RESPONSE' });
});

test('v6 accepts only selected opening IDs, restores exact boundaries, and accepts at most one plan per opening', () => {
  const f = fixture(50, 35), seq = sequence(f, 'speech-4');
  const checked = validateAiStructureResponse(f, response([seq, ['speech-4', 'speech-1', 'speech-50'], sequence(f, 'speech-40')]));
  assert.equal(checked.plans.length, 1); assert.deepEqual(checked.sequences, [seq]);
  assert.equal(checked.plans[0].version, AI_STRUCTURE_VERSION);
  assert.deepEqual(checked.plans[0].clips.map(clip => [clip.startMs, clip.endMs]), seq.map(id => { const c = f.engineInput.candidates.find(c => c.id === id); return [c.startMs, c.endMs]; }));
  assert.equal(getAiCuratedCoverage(f, checked.sequences).total, 35);
  assert.throws(() => validateAiStructureResponse(f, { ...response([seq]), complete: true }), { code: 'AI_STRUCTURE_INVALID_RESPONSE' });
});

for (const count of [35, 50]) test(`${count} selected openings are covered in bounded groups; reopen never calls the model`, async t => {
  const root = await rootFor(t), f = fixture(70, count), calls = [];
  const service = createAiStructurePlans({ readInput: async () => f, modelIdentity: { model: 'mock', maxOutputTokens: 65536 }, modelClient: async args => {
    const body = JSON.parse(args.input); calls.push(body); assert.equal(args.purpose, 'curated-composition');
    assert.equal(body.previous, undefined); return currentResponse(body.openingIds.map(id => sequence(f, id)));
  } });
  const state = await service.status(root, f.scope);
  assert.equal(state.confirmation.openingCount, count); assert.equal(state.confirmation.batchCount, Math.ceil(count / 8));
  await service.generate(root, { ...f.scope, confirmed: true, confirmationId: state.confirmation.id }); await service.wait();
  const finished = await service.status(root, f.scope);
  assert.equal(finished.plans.length, count); assert.equal(finished.coverage.total, count); assert.equal(finished.complete, true);
  await service.status(root, f.scope); assert.equal(calls.length, Math.ceil(count / 8));
});

test('only missing openings get one correction; a transport failure is saved and is never retried automatically', async t => {
  const root = await rootFor(t), f = fixture(50, 35), calls = [];
  const service = createAiStructurePlans({ readInput: async () => f, modelIdentity: { model: 'mock' }, modelClient: async args => {
    const body = JSON.parse(args.input); calls.push(body);
    if (calls.length === 2) throw Error('Mock interrupted request');
    return currentResponse(body.openingIds.slice(0, -1).map(id => sequence(f, id)));
  } });
  const before = await service.status(root, f.scope);
  await service.generate(root, { ...f.scope, confirmed: true, confirmationId: before.confirmation.id }); await service.wait();
  assert.deepEqual(calls.map(body => body.openingIds.length), [8, 1]);
  const after = await service.status(root, f.scope); assert.equal(after.status, 'failed'); assert.equal(after.plans.length, 7);
  await service.recover(root, f.scope); assert.equal(calls.length, 2);
});

test('saved v5 seeds and results retain their IDs and bytes; explicit new v6 requests contain none of that history', async t => {
  const root = await rootFor(t), f = fixture(50, 35), version = 'ai-structure-plans-v5';
  const result = validateAiStructureVariants(f, { schema: version, plans: [sequence(f, 'speech-0')] });
  const key = sharedHash({ kind: version, prompt: aiStructurePrompt(version), analysis: f.analysisVersion, semantic: f.semanticVersion, input: inspectAiVariantsInput(f.engineInput).inputHash, visibility: f.visibility });
  const seedPlan = { ...result.plans[0], id: 'preserved-seed-plan' };
  const saved = { version, key, sourceId: f.source.id, seed: { plans: [seedPlan], sequences: [sequence(f, 'speech-1')] }, rounds: [{ status: 'complete', result }], pass: { number: 1, processedOpeningIds: ['speech-0'] } };
  await mkdir(join(root, '.film/ai-structure-plans'), { recursive: true }); const file = join(root, '.film/ai-structure-plans', `${key}.json`), bytes = JSON.stringify(saved);
  await writeFile(file, bytes);
  const calls = [], service = createAiStructurePlans({ readInput: async () => f, modelIdentity: { model: 'mock' }, modelClient: async args => {
    const body = JSON.parse(args.input); calls.push(body); return currentResponse(body.openingIds.map(id => sequence(f, id)));
  } });
  const old = await service.status(root, f.scope); assert.deepEqual(old.plans.map(p => p.id), [seedPlan.id, result.plans[0].id]);
  const request = { ...f.scope, rulesVersion: 'ai-structure-plans-v8' }, before = await service.status(root, request);
  await service.generate(root, { ...request, confirmed: true, confirmationId: before.confirmation.id }); await service.wait();
  assert.equal(calls.length, 5); assert.equal(calls[0].previous, undefined); assert.equal(await readFile(file, 'utf8'), bytes);
});

test('analysis retains opening metadata with original cue times and merges overlapping windows without losing selection', async () => {
  const f = fixture(3), args = { ...f.scope, rangeStartMs: f.scope.startMs, rangeEndMs: f.scope.endMs, cues: f.engineInput.cues };
  const candidate = { firstCue: 0, lastCue: 0, subject: { kind: 'self', evidence: [0] }, tags: ['卖点'], opening: { group: '单手方便使用', followup: '说明单手怎么操作' } };
  const run = candidates => analyzeTextStructure({ ...args, client: async () => ({ schema: 'complete-speech-v1', candidates, issues: [] }) });
  const selected = await run([candidate]), ordinary = await run([{ ...candidate, opening: undefined }]);
  assert.deepEqual(selected.candidates[0].details.composition.opening, candidate.opening);
  assert.deepEqual([selected.candidates[0].startMs, selected.candidates[0].endMs], [0, 13000]);
  const combined = combineTextStructureWindows({ ...args, outputs: [ordinary, selected] });
  assert.equal(combined.candidates.length, 1); assert.deepEqual(combined.candidates[0].details.composition.opening, candidate.opening);
  for (const opening of [null, {}, { group: 'x', followup: '' }, { ...candidate.opening, score: 99 }]) await assert.rejects(run([{ ...candidate, opening }]), { code: 'MODEL_CONSTRAINT' });
});

test('composition uses high/65536 with matching identity and receipt; analysis stays high/65536', async () => {
  for (const purpose of [undefined, 'curated-composition']) {
    const config = { id: 'mock', baseUrl: 'https://api.deepseek.com', model: 'mock', apiKey: 'fake' }, requests = [], receipts = [];
    const client = createDeepSeekTextClient({ purpose, getConfig: async () => config, getPublicConfig: async () => config,
      fetch: async (_url, options) => { requests.push(JSON.parse(options.body)); return { ok: true, status: 200, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: '{}' }] }] }) }; } });
    await client({ system: 'mock', input: '{}', onReceipt: receipt => receipts.push(receipt) });
    const cap = purpose ? 65536 : 65536;
    assert.equal(requests[0].max_output_tokens, cap); assert.equal(requests[0].reasoning.effort, 'high'); assert.equal(receipts[0].maxOutputTokens, cap);
    assert.equal((await client.getCacheIdentity()).maxOutputTokens, cap);
    const bridgeCalls = [], desktop = createDesktopAnalysisServices({ textBridge: async message => { bridgeCalls.push(message); return message.operation === 'public-config' ? config : { value: {} }; } }).liveAnalysis.modelClient;
    const expectedIdentity = await desktop.getCacheIdentity({ purpose }); assert.equal(expectedIdentity.maxOutputTokens, cap);
    await desktop({ system: 'mock', input: '{}', expectedIdentity, purpose }); assert.equal(bridgeCalls.at(-1).purpose, purpose);
  }
});
