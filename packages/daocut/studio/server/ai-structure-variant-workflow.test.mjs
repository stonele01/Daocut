import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { createAiStructurePlans } from './ai-structure-plans.mjs';
import { aiStructurePrompt, createAiStructureRequest, validateAiStructureResponse } from './ai-structure.mjs';
import { AI_STRUCTURE_ORDER_VERSION, inspectAiOrderInput, validateAiStructureOrder } from './ai-structure-order.mjs';
import { AI_STRUCTURE_VARIANTS_VERSION } from './ai-structure-variants.mjs';
import { sharedHash } from './shared-analysis.mjs';

const base = resolve(import.meta.dirname, '../../../../.tmp/variant-workflow-tests');
function material(openingCount = 10) {
  const scope = { sourceId: 's', productId: 'p', intervalId: 'i', startMs: 0, endMs: (openingCount + 1) * 15000 };
  const cues = Array.from({ length: openingCount + 1 }, (_, n) => ({ text: `完整模拟原话${n}`, startMs: n * 15000, endMs: n * 15000 + 13000 }));
  const candidates = cues.map((cue, n) => ({ ...scope, ...cue, id: `speech-${n}`, cueRange: [n, n], tags: [n === openingCount ? '行动指令' : n < 3 ? '卖点' : '痛点'],
    details: { composition: { contract: 'complete-speech-v1', status: 'confirmed', roles: [n === openingCount ? 'purchase' : n < 3 ? 'core' : 'pain'], requires: [], excludes: [], conditions: {} } } }));
  return { source: { id: 's', assetPath: 'assets/mock.mp4' }, scope, context: scope, visibility: 'local', analysisVersion: 'analysis-original', semanticVersion: 'semantic-original',
    engineInput: { scope, sourceIdentity: 'synthetic', candidates, cues }, issues: [] };
}
const output = (plans = []) => ({ schema: AI_STRUCTURE_VARIANTS_VERSION, plans });
function alternative(body, id) {
  const end = body.units.find(unit => unit.roles.includes('purchase')).id;
  const candidates = body.units.filter(unit => unit.roles.includes('core') && unit.id !== id).map(unit => [id, unit.id, end]);
  return candidates.filter(sequence => !body.previous.some(previous => JSON.stringify(previous) === JSON.stringify(sequence)));
}
async function receipt(args, value, usage = {}) {
  const hash = value => createHash('sha256').update(value).digest('hex'), rawText = JSON.stringify(value);
  await args.onReceipt({ responseVersion: 'deepseek-text-receipt-v1', provider: 'deepseek', status: 'completed', httpStatus: 200,
    inputSha256: hash(JSON.stringify([args.system, args.input])), rawText, rawTextSha256: hash(rawText), usage });
}
async function fixture(t, { count = 10, seed = true, maxOutputTokens = 5000, visibility = 'local', respond = () => output() } = {}) {
  await mkdir(base, { recursive: true }); const root = await mkdtemp(join(base, 'case-'));
  t.mock.method(globalThis, 'fetch', () => { throw Error('Network forbidden'); });
  const input = material(count), model = { provider: 'mock', model: 'fixture-model', endpoint: 'mock://local', maxOutputTokens }, calls = [], services = [];
  input.visibility = visibility;
  const oldKey = sharedHash({ kind: AI_STRUCTURE_ORDER_VERSION, prompt: aiStructurePrompt(AI_STRUCTURE_ORDER_VERSION), analysis: input.analysisVersion,
    semantic: input.semanticVersion, input: inspectAiOrderInput(input.engineInput).inputHash, visibility: input.visibility });
  const oldPath = join(root, '.film/ai-structure-plans', `${oldKey}.json`);
  const sequences = input.engineInput.candidates.slice(0, count).map(candidate => [candidate.id, input.engineInput.candidates.find(other => other.id !== candidate.id && other.details.composition.roles.includes('core')).id, `speech-${count}`]);
  const oldResponse = { schema: AI_STRUCTURE_ORDER_VERSION, plans: sequences };
  const oldResult = validateAiStructureOrder(input, oldResponse);
  assert.equal(oldResult.plans.length, count);
  const oldRecord = { version: AI_STRUCTURE_ORDER_VERSION, key: oldKey, sourceId: input.source.id,
    rounds: [{ status: 'complete', submitted: true, openingIds: sequences.map(sequence => sequence[0]), model,
      response: oldResponse, result: oldResult, receipt: { status: 'completed', usage: { output_tokens: count * 1000 } } }] };
  const oldBytes = JSON.stringify(oldRecord);
  if (seed) { await mkdir(join(root, '.film/ai-structure-plans'), { recursive: true }); await writeFile(oldPath, oldBytes); }
  const make = (extra = {}) => {
    const service = createAiStructurePlans({ readInput: async () => structuredClone(input), modelIdentity: model,
      modelClient: async args => { const body = JSON.parse(args.input); calls.push({ body, system: args.system, input: args.input }); return respond(body, args, calls.length); }, ...extra });
    services.push(service); return service;
  };
  t.after(async () => { for (const service of services) await service.wait(); assert.ok(resolve(root).startsWith(base + sep)); await rm(root, { recursive: true, force: true }); });
  const request = { ...input.scope, rulesVersion: AI_STRUCTURE_VARIANTS_VERSION };
  async function generate(service, continuation = false) {
    const before = await service.status(root, request);
    assert.equal(before.confirmation?.enabled, true);
    return service.generate(root, { ...request, confirmed: true, confirmationId: before.confirmation.id, continue: continuation });
  }
  return { root, input, model, calls, make, request, generate, oldPath, oldBytes, oldRecord, oldResult };
}

function sharedStore({ reuseFirstBatch = false } = {}) {
  const results = new Map(), prepared = [], claims = [], descriptors = new Map();
  let firstBatchSeeded = false;
  return { results, prepared, claims, api: {
    validateSource: async () => {},
    prepareExisting: async (_root, _source, artifact) => {
      const taskKey = sharedHash(artifact.payload);
      prepared.push({ taskKey, payload: structuredClone(artifact.payload) });
      if (reuseFirstBatch && !firstBatchSeeded && artifact.payload.kind === AI_STRUCTURE_VARIANTS_VERSION) {
        firstBatchSeeded = true;
        results.set(taskKey, { schema: AI_STRUCTURE_VARIANTS_VERSION, requestHash: artifact.payload.requestHash, response: output() });
      }
      const descriptor = { taskKey, dataHash: taskKey, catalog: { action: artifact.action, scope: artifact.scope }, mode: results.has(taskKey) ? 'reuse' : 'publish' };
      descriptors.set(taskKey, descriptor); return descriptor;
    },
    history: async () => ({ results: [...results.keys()].map(taskKey => ({ taskKey, catalog: descriptors.get(taskKey).catalog, result: { sha256: taskKey } })) }),
    historicalArtifact: async (_root, _source, taskKey) => ({ descriptor: descriptors.get(taskKey), result: { sha256: taskKey }, snapshot: { dataHash: taskKey, payload: structuredClone(results.get(taskKey)) } }),
    acquire: async descriptor => { claims.push(descriptor.taskKey); return { attemptId: `mock-claim-${claims.length}` }; },
    read: async (_root, descriptor) => ({ payload: structuredClone(results.get(descriptor.taskKey)) }),
    complete: async (_root, descriptor, _attemptId, payload) => { results.set(descriptor.taskKey, structuredClone(payload)); },
    fail: async () => {},
  } };
}

test('reading v5 seeds exact saved v4 plans without changing IDs, source times or any old file bytes', async t => {
  const f = await fixture(t, { count: 70 }), service = f.make();
  const state = await service.status(f.root, f.request);
  assert.equal(f.calls.length, 0); assert.equal(state.plans.length, 70);
  assert.deepEqual(state.plans.map(plan => plan.id), f.oldResult.plans.map(plan => plan.id));
  assert.deepEqual(state.plans.map(plan => plan.clips.map(clip => [clip.startMs, clip.endMs])), f.oldResult.plans.map(plan => plan.clips.map(clip => [clip.startMs, clip.endMs])));
  assert.equal(state.coverage.openingCovered, 70); assert.equal(state.coverage.covered, 0);
  assert.equal(await readFile(f.oldPath, 'utf8'), f.oldBytes);
  assert.equal((await readdir(join(f.root, '.film/ai-structure-plans'))).length, 1, 'status must not create a v5 task');
  const legacy = await service.status(f.root, { ...f.request, rulesVersion: AI_STRUCTURE_ORDER_VERSION });
  assert.equal(legacy.plans.length, 70); assert.equal(legacy.version, AI_STRUCTURE_ORDER_VERSION);
});

for (const legacyPayload of [false, true]) test(`a colleague opens every adaptive batch without recalculating the publisher budget (legacy=${legacyPayload})`, async t => {
  const shared = sharedStore();
  const author = await fixture(t, { count: 10, seed: false, visibility: 'shared', respond: async (body, args) => {
    const value = output(body.openingIds.flatMap(id => alternative(body, id).slice(0, 1)));
    await receipt(args, value, { output_tokens: body.openingIds.length * 100 }); return value;
  } });
  const a = author.make({ sharedAnalysis: shared.api }); await author.generate(a); await a.wait();
  assert.deepEqual(author.calls.map(call => call.body.openingIds.length), [1, 9]);
  if (legacyPayload) for (const value of shared.results.values()) delete value.budgetSample;
  const reader = await fixture(t, { count: 10, seed: false, visibility: 'shared' });
  const b = reader.make({ sharedAnalysis: shared.api, modelIdentity: { ...reader.model, reasoningEffort: 'high', maxOutputTokens: 9000 } });
  const state = await b.status(reader.root, reader.request);
  assert.equal(state.plans.length, 10); assert.deepEqual(state.coverage.remainingIds, []); assert.equal(state.complete, true);
  assert.equal(reader.calls.length, 0); assert.equal(shared.claims.length, 2);
  const file = join(reader.root, '.film/ai-structure-plans', `${state.taskKey}.json`), bytes = await readFile(file, 'utf8');
  await b.status(reader.root, reader.request); assert.equal(await readFile(file, 'utf8'), bytes);
  assert.equal(reader.calls.length, 0);
});

test('shared coverage corrections are imported after an empty first result, including old payloads without budget metadata', async t => {
  const shared = sharedStore();
  const author = await fixture(t, { count: 4, seed: false, visibility: 'shared', respond: (body, _args, number) =>
    number % 2 ? output() : output(body.openingIds.flatMap(id => alternative(body, id).slice(0, 1))) });
  const a = author.make({ sharedAnalysis: shared.api }); await author.generate(a); await a.wait();
  assert.equal(author.calls.length, 8);
  for (const value of shared.results.values()) delete value.budgetSample;
  const reader = await fixture(t, { count: 4, seed: false, visibility: 'shared' });
  const b = reader.make({ sharedAnalysis: shared.api }), state = await b.status(reader.root, reader.request);
  assert.equal(state.plans.length, 4); assert.equal(state.complete, true); assert.equal(state.coverage.openingCovered, 4);
  assert.equal(reader.calls.length, 0); assert.equal(shared.claims.length, 8);
  const saved = JSON.parse(await readFile(join(reader.root, '.film/ai-structure-plans', `${state.taskKey}.json`), 'utf8'));
  assert.equal(saved.rounds.filter(round => round.correction).length, 4);
});

test('an unanalyzed input returns unavailable with its original reason instead of attempting opening coverage', async () => {
  const service = createAiStructurePlans({ readInput: async () => ({ source: { id: 's' }, scope: {}, visibility: 'unavailable', issues: [{ code: 'NO_ANALYSIS', message: '请先分析话术' }] }) });
  const state = await service.status('unused', { sourceId: 's', rulesVersion: AI_STRUCTURE_VARIANTS_VERSION });
  assert.equal(state.status, 'unavailable'); assert.equal(state.canContinue, false); assert.equal(state.coverage, undefined);
  assert.equal(state.issues[0].message, '请先分析话术');
});

test('upgrading an employee who already skipped earlier corrections restores all of them in their original order', async t => {
  const shared = sharedStore();
  const author = await fixture(t, { count: 4, seed: false, visibility: 'shared', respond: (body, _args, number) =>
    number % 2 ? output() : output(body.openingIds.flatMap(id => alternative(body, id).slice(0, 1))) });
  const a = author.make({ sharedAnalysis: shared.api }); await author.generate(a); await a.wait();
  for (const value of shared.results.values()) delete value.budgetSample;
  const reader = await fixture(t, { count: 4, seed: false, visibility: 'shared' });
  const old = reader.make({ sharedAnalysis: { ...shared.api, history: undefined, historicalArtifact: undefined } });
  for (let i = 0; i < 4; i++) assert.equal((await old.status(reader.root, reader.request)).plans.length, 0);
  const upgraded = reader.make({ sharedAnalysis: shared.api }), state = await upgraded.status(reader.root, reader.request);
  assert.equal(state.plans.length, 4); assert.equal(state.coverage.openingCovered, 4); assert.equal(state.complete, true);
  const file = join(reader.root, '.film/ai-structure-plans', `${state.taskKey}.json`), bytes = await readFile(file, 'utf8');
  const saved = JSON.parse(bytes);
  assert.deepEqual(saved.rounds.map(round => round.correction), [false, true, false, true, false, true, false, true]);
  await upgraded.status(reader.root, reader.request); assert.equal(await readFile(file, 'utf8'), bytes);
  assert.equal(reader.calls.length, 0); assert.equal(shared.claims.length, 8);
});

for (const explicitVersion of [true, false]) test(`a new colleague can read a v5 pass seeded by the authors saved v4 plans (explicit=${explicitVersion})`, async t => {
  const shared = sharedStore();
  const author = await fixture(t, { count: 4, visibility: 'shared', respond: body => output(body.openingIds.flatMap(id => alternative(body, id))) });
  const a = author.make({ sharedAnalysis: shared.api }); await author.generate(a); await a.wait();
  const expected = await a.status(author.root, author.request);
  const reader = await fixture(t, { count: 4, seed: false, visibility: 'shared' });
  const b = reader.make({ sharedAnalysis: shared.api }), state = await b.status(reader.root, { ...reader.request, rulesVersion: explicitVersion ? AI_STRUCTURE_VARIANTS_VERSION : undefined });
  assert.deepEqual(state.plans.map(plan => plan.id), expected.plans.map(plan => plan.id));
  assert.equal(reader.calls.length, 0);
});

test('many existing variants cannot make a valid published small batch unreadable through a larger hypothetical request', async t => {
  const f = await fixture(t, { count: 40, seed: false, visibility: 'shared' }), shared = sharedStore();
  f.input.engineInput.candidates.forEach((candidate, index) => {
    candidate.id = `cue-${index.toString(16).padStart(24, '0')}`;
    candidate.tags = [index === 40 ? '行动指令' : index < 10 ? '卖点' : '痛点'];
    candidate.details.composition.roles = [index === 40 ? 'purchase' : index < 10 ? 'core' : 'pain'];
  });
  const service = f.make({ sharedAnalysis: shared.api }), initial = await service.status(f.root, f.request);
  const ids = f.input.engineInput.candidates.slice(0, 40).map(c => c.id), cores = ids.slice(0, 10), end = f.input.engineInput.candidates.at(-1).id;
  const rounds = [], history = [];
  const prepare = async (request, passNumber) => shared.api.prepareExisting(f.root, f.input.source, { action: 'structure-plans',
    scope: { startMs: f.input.scope.startMs, endMs: f.input.scope.endMs }, payload: { kind: AI_STRUCTURE_VARIANTS_VERSION, key: initial.taskKey, requestHash: sharedHash(request), passNumber, correction: false } });
  for (const id of ids) {
    const sequences = cores.filter(core => core !== id).map(core => [id, core, end]);
    if (!cores.includes(id)) for (let i = 0; i < cores.length; i++) for (let j = i + 1; j < cores.length && sequences.length < 40; j++) sequences.push([id, cores[i], cores[j], end]);
    const request = createAiStructureRequest(f.input, { version: AI_STRUCTURE_VARIANTS_VERSION, openingIds: [id], previous: history });
    const response = output(sequences), result = validateAiStructureResponse(f.input, response, { expectedVersion: AI_STRUCTURE_VARIANTS_VERSION, openingIds: [id], previous: JSON.parse(request.input).previous });
    assert.equal(result.plans.length, sequences.length);
    rounds.push({ status: 'complete', request, descriptor: await prepare(request, 1), response, result, openingIds: [id], passNumber: 1, correction: false });
    history.push(...result.sequences);
  }
  const saved = { version: AI_STRUCTURE_VARIANTS_VERSION, key: initial.taskKey, sourceId: f.input.source.id, rounds, pass: { number: 1, openingIds: ids, processedOpeningIds: ids } };
  const file = join(f.root, '.film/ai-structure-plans', `${initial.taskKey}.json`); await mkdir(join(f.root, '.film/ai-structure-plans'), { recursive: true }); await writeFile(file, JSON.stringify(saved));
  assert.throws(() => createAiStructureRequest(f.input, { version: AI_STRUCTURE_VARIANTS_VERSION, openingIds: ids, previous: history }), { code: 'AI_STRUCTURE_INPUT_TOO_LARGE' });
  const request = createAiStructureRequest(f.input, { version: AI_STRUCTURE_VARIANTS_VERSION, openingIds: [ids[0]], previous: history }), descriptor = await prepare(request, 2);
  await shared.api.complete(f.root, descriptor, null, { schema: AI_STRUCTURE_VARIANTS_VERSION, requestHash: sharedHash(request), response: output() });
  const state = await service.status(f.root, f.request), after = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(after.pass.number, 2); assert.equal(after.rounds.length, 41); assert.equal(state.coverage.remainingIds.length, 39);
  assert.equal(state.plans.length, 1290); assert.equal(f.calls.length, 0); assert.equal(state.confirmation.enabled, true);
});

test('a shared seed added to an existing partial v5 record persists across reopen', async t => {
  const shared = sharedStore();
  const author = await fixture(t, { count: 4, visibility: 'shared', respond: body => output(body.openingIds.flatMap(id => id === 'speech-0' ? alternative(body, id).slice(0, 1) : [])) });
  const old = structuredClone(author.oldRecord);
  for (const field of ['plans']) old.rounds[0].response[field] = old.rounds[0].response[field].slice(1);
  for (const field of ['sequences', 'plans']) old.rounds[0].result[field] = old.rounds[0].result[field].slice(1);
  old.rounds[0].openingIds = old.rounds[0].openingIds.slice(1);
  await writeFile(author.oldPath, JSON.stringify(old));
  const a = author.make({ sharedAnalysis: shared.api, modelIdentity: { ...author.model, reasoningEffort: 'high' } });
  await author.generate(a); await a.wait();
  const reader = await fixture(t, { count: 4, seed: false, visibility: 'shared' });
  const oldReader = reader.make({ sharedAnalysis: { ...shared.api, history: undefined, historicalArtifact: undefined } });
  assert.equal((await oldReader.status(reader.root, reader.request)).plans.length, 1);
  const b = reader.make({ sharedAnalysis: shared.api }), state = await b.status(reader.root, reader.request);
  assert.equal(state.plans.length, 4);
  const reopened = await reader.make({ sharedAnalysis: shared.api }).status(reader.root, reader.request);
  assert.deepEqual(reopened.plans.map(p => p.id), state.plans.map(p => p.id));
  assert.equal(reader.calls.length, 0);
});

test('an unreadable unrelated history artifact cannot hide valid published batches or authorize duplicate model calls', async t => {
  const shared = sharedStore();
  const author = await fixture(t, { count: 4, seed: false, visibility: 'shared', respond: body => output(body.openingIds.flatMap(id => alternative(body, id).slice(0, 1))) });
  const a = author.make({ sharedAnalysis: shared.api }); await author.generate(a); await a.wait();
  const brokenKey = 'unreadable-old-version';
  const api = { ...shared.api,
    history: async () => { const history = await shared.api.history(); history.results.unshift({ taskKey: brokenKey, catalog: { action: 'structure-plans', scope: { startMs: author.input.scope.startMs, endMs: author.input.scope.endMs } }, result: { sha256: brokenKey } }); return history; },
    historicalArtifact: async (...args) => { if (args[2] === brokenKey) throw Error('old file unavailable'); return shared.api.historicalArtifact(...args); },
  };
  const reader = await fixture(t, { count: 4, seed: false, visibility: 'shared' }), b = reader.make({ sharedAnalysis: api });
  const state = await b.status(reader.root, reader.request);
  assert.equal(state.status, 'complete'); assert.equal(state.plans.length, 4); assert.equal(state.confirmation, undefined);
  assert.equal((await b.status(reader.root, reader.request)).plans.length, 4);
  assert.equal(reader.calls.length, 0); assert.equal(shared.claims.length, 4);
});

test('one seeded opening may yield several new variants while others yield zero, and the pass ends without quantity retries', async t => {
  const f = await fixture(t, { count: 4, respond: body => output(body.openingIds.flatMap(id => id === 'speech-3' ? alternative(body, id) : id === 'speech-0' ? alternative(body, id).slice(0, 1) : [])) });
  const service = f.make(); await f.generate(service); await service.wait();
  const done = await service.status(f.root, f.request);
  assert.equal(f.calls.length, 1); assert.equal(done.plans.length, 7); assert.equal(done.complete, true);
  assert.equal(done.coverage.covered, 4); assert.equal(done.coverage.openingCovered, 4); assert.deepEqual(done.coverage.remainingIds, []);
  assert.equal(done.coverage.perOpening.find(item => item.openingId === 'speech-3').distinctCount, 3);
  assert.equal(done.coverage.perOpening.find(item => item.openingId === 'speech-1').distinctCount, 1);
  assert.equal(done.allValidCombinationsEnumerated, false); assert.equal(done.canContinue, true);
  assert.equal(await readFile(f.oldPath, 'utf8'), f.oldBytes);
  await f.make().status(f.root, f.request); assert.equal(f.calls.length, 1, 'reopening never silently expands again');
});

test('successive batches keep a stable catalog prefix and send only the selected openings existing sequences', async t => {
  const f = await fixture(t), service = f.make();
  await f.generate(service); await service.wait();
  assert.deepEqual(f.calls.map(call => call.body.openingIds.length), [4, 4, 2]);
  const prefix = f.calls[0].input.split(',"openingIds":')[0];
  for (const call of f.calls) {
    assert.equal(call.input.split(',"openingIds":')[0], prefix); assert.equal(call.system, f.calls[0].system);
    assert.equal(call.body.previous.length, call.body.openingIds.length);
    assert(call.body.previous.every(sequence => call.body.openingIds.includes(sequence[0])));
    assert.equal(call.body.targetCounts, undefined); assert.equal(call.body.targetVariants, undefined);
    assert.equal(call.body.transcript, undefined);
  }
  const done = await service.status(f.root, f.request);
  assert.equal(done.complete, true); assert.equal(done.plans.length, 10);
});

test('observed output usage and the configured output budget determine different batch sizes', async t => {
  const small = await fixture(t, { maxOutputTokens: 3000 }), large = await fixture(t, { maxOutputTokens: 5000 });
  const smallService = small.make(), largeService = large.make();
  const a = await smallService.status(small.root, small.request), b = await largeService.status(large.root, large.request);
  assert.equal(a.confirmation.batchBasis, 'observed-output'); assert.equal(b.confirmation.batchBasis, 'observed-output');
  assert.equal(a.confirmation.batchCount, 5); assert.equal(b.confirmation.batchCount, 3);
  await small.generate(smallService); await smallService.wait(); await large.generate(largeService); await largeService.wait();
  assert.deepEqual(small.calls.map(call => call.body.openingIds.length), [2, 2, 2, 2, 2]);
  assert.deepEqual(large.calls.map(call => call.body.openingIds.length), [4, 4, 2]);
  assert(small.calls.length <= a.confirmation.requestCount); assert(large.calls.length <= b.confirmation.requestCount);
});

test('a changed reasoning effort starts with a pilot while preserving all saved plans', async t => {
  const f = await fixture(t);
  const service = f.make({ modelIdentity: { ...f.model, reasoningEffort: 'high' } });
  const state = await service.status(f.root, f.request);
  assert.equal(state.plans.length, 10);
  assert.equal(state.confirmation.batchBasis, 'first-opening');
  assert.equal(state.confirmation.batchCount, 10);
  assert.equal(f.calls.length, 0);
});

test('receipt recovery validates the exact failed batch and preserves seeds without another model request or automatic resume', async t => {
  const f = await fixture(t, { count: 6, maxOutputTokens: 3000, respond: async (body, args, number) => {
    const value = output(body.openingIds.flatMap(id => alternative(body, id).slice(0, 1)));
    if (number === 2) { await receipt(args, value); throw Error('mock connection lost after completed receipt'); }
    return value;
  } });
  const service = f.make(); await f.generate(service); await service.wait();
  const failed = await service.status(f.root, f.request);
  assert.equal(failed.status, 'failed'); assert.equal(failed.plans.length, 8); assert.equal(f.calls.length, 2);
  assert.equal(failed.coverage.processedOpeningIds.length, 2);
  const restarted = f.make(); await restarted.status(f.root, f.request); assert.equal(f.calls.length, 2);
  const recovered = await restarted.recover(f.root, f.request);
  assert.equal(recovered.status, 'complete'); assert.equal(recovered.complete, false);
  assert.equal(recovered.plans.length, 10); assert.equal(recovered.coverage.processedOpeningIds.length, 4);
  assert.equal(recovered.coverage.remainingIds.length, 2); assert.equal(f.calls.length, 2);
  assert.deepEqual(recovered.plans.slice(0, 6).map(plan => plan.id), f.oldResult.plans.map(plan => plan.id));
  assert.equal(await readFile(f.oldPath, 'utf8'), f.oldBytes);
});

test('never-covered openings get only one extra coverage attempt and zero-result attempts still complete the bounded pass', async t => {
  const f = await fixture(t, { count: 4, seed: false }), service = f.make();
  const preview = await service.status(f.root, f.request);
  assert.equal(preview.confirmation.batchBasis, 'first-opening'); assert.equal(preview.confirmation.requestCount, 8);
  await f.generate(service); await service.wait();
  const done = await service.status(f.root, f.request);
  assert.equal(f.calls.length, 8); assert.equal(done.complete, true); assert.equal(done.plans.length, 0);
  assert.equal(done.coverage.openingCovered, 0); assert.equal(done.coverage.covered, 4);
  assert.deepEqual(f.calls.map(call => call.body.openingIds), [['speech-0'], ['speech-0'], ['speech-1'], ['speech-1'], ['speech-2'], ['speech-2'], ['speech-3'], ['speech-3']]);
  assert.equal(done.allValidCombinationsEnumerated, false); assert.equal(done.canContinue, true);
});

test('an input change between v5 batches stops further requests and records the stop without rewriting the seed', async t => {
  let f;
  f = await fixture(t, { count: 6, maxOutputTokens: 3000, respond: () => { f.input.analysisVersion = 'changed'; return output(); } });
  const service = f.make(), before = await service.status(f.root, f.request);
  await f.generate(service); await service.wait();
  assert.equal(f.calls.length, 1);
  const saved = JSON.parse(await readFile(join(f.root, '.film/ai-structure-plans', `${before.taskKey}.json`), 'utf8'));
  assert.equal(saved.rounds.length, 1); assert.equal(saved.seed.plans.length, 6);
  assert.match(saved.operationError, /话术或核查记录已变化/);
  assert.equal(await readFile(f.oldPath, 'utf8'), f.oldBytes);
});

test('a first-opening pilot with low observed usage combines the remaining openings into the next request', async t => {
  const f = await fixture(t, { count: 10, seed: false, maxOutputTokens: 5000, respond: async (body, args) => {
    const value = output(body.openingIds.flatMap(id => alternative(body, id).slice(0, 1)));
    await receipt(args, value, { output_tokens: body.openingIds.length * 100 });
    return value;
  } });
  const service = f.make(), before = await service.status(f.root, f.request);
  assert.equal(before.confirmation.batchBasis, 'first-opening');
  await f.generate(service); await service.wait();
  const done = await service.status(f.root, f.request);
  assert.deepEqual(f.calls.map(call => call.body.openingIds.length), [1, 9]);
  assert.equal(done.coverage.processedOpeningIds.length, 10); assert.equal(done.coverage.openingCovered, 10);
  assert.equal(done.complete, true); assert.equal(done.plans.length, 10);
  assert(f.calls.length <= before.confirmation.requestCount);
});

test('higher observed output shrinks later groups and stops at the originally confirmed request limit', async t => {
  const f = await fixture(t, { count: 70, maxOutputTokens: 5000, respond: async (body, args) => {
    const value = output(body.openingIds.flatMap(id => alternative(body, id).slice(0, 1)));
    await receipt(args, value, { output_tokens: 5000 });
    return value;
  } });
  const service = f.make(), before = await service.status(f.root, f.request);
  assert.equal(before.confirmation.batchCount, 18); assert.equal(before.confirmation.requestCount, 36);
  await f.generate(service); await service.wait();
  const done = await service.status(f.root, f.request);
  assert.deepEqual(f.calls.slice(0, 4).map(call => call.body.openingIds.length), [4, 3, 1, 1]);
  assert.equal(f.calls.length, before.confirmation.requestCount);
  assert.equal(done.complete, false); assert(done.coverage.remainingIds.length > 0);
  assert.equal(done.canContinue, true); assert(done.issues.some(issue => /上限|预算|次数已用完/.test(issue.message)));
  assert.equal(await readFile(f.oldPath, 'utf8'), f.oldBytes);
  await service.status(f.root, f.request); await f.make().status(f.root, f.request);
  assert.equal(f.calls.length, before.confirmation.requestCount, 'status/restart cannot authorize another paid batch');
});

test('display coverage and plan clips use matching local IDs while model requests keep stable public IDs', async t => {
  const f = await fixture(t, { count: 4 });
  f.input.localCandidateIds = Object.fromEntries(f.input.engineInput.candidates.map(candidate => [candidate.id, `local-${candidate.id}`]));
  const service = f.make(), state = await service.status(f.root, f.request);
  assert(state.plans.every(plan => state.coverage.perOpening.some(item => item.openingId === plan.clips[0].candidateId)));
  assert(state.coverage.openingIds.every(id => id.startsWith('local-')));
  assert(state.coverage.remainingIds.every(id => id.startsWith('local-')));
  assert(state.coverage.excluded.every(item => item.id.startsWith('local-')));
  await f.generate(service); await service.wait();
  assert(f.calls.every(call => call.body.openingIds.every(id => id.startsWith('speech-'))));
  assert(f.calls.every(call => call.body.previous.every(sequence => sequence.every(id => id.startsWith('speech-')))));
  const done = await service.status(f.root, f.request);
  assert.equal(done.complete, true);
  assert(done.coverage.processedOpeningIds.every(id => id.startsWith('local-')));
  assert(done.plans.every(plan => done.coverage.perOpening.some(item => item.openingId === plan.clips[0].candidateId)));
  assert.equal(await readFile(f.oldPath, 'utf8'), f.oldBytes);
});

test('shared zero-addition completion is read-idempotent and only explicit continuation claims a new pass', async t => {
  const f = await fixture(t, { count: 4, visibility: 'shared' }), shared = sharedStore();
  const service = f.make({ sharedAnalysis: shared.api });
  await f.generate(service); await service.wait();
  const done = await service.status(f.root, f.request);
  assert.equal(done.complete, true); assert.equal(done.plans.length, 4); assert.equal(f.calls.length, 1);
  const file = join(f.root, '.film/ai-structure-plans', `${done.taskKey}.json`);
  const completedBytes = await readFile(file, 'utf8');
  for (let n = 0; n < 3; n++) await service.status(f.root, f.request);
  await f.make({ sharedAnalysis: shared.api }).status(f.root, f.request);
  assert.equal(await readFile(file, 'utf8'), completedBytes, 'reading the next confirmation cannot append the old public zero result');
  assert.equal(shared.claims.length, 1); assert.equal(f.calls.length, 1);
  await f.generate(service, true); await service.wait();
  const second = await service.status(f.root, f.request), saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(second.complete, true); assert.equal(second.plans.length, 4);
  assert.equal(saved.rounds.length, 2); assert.equal(saved.pass.number, 2);
  assert.equal(f.calls.length, 2); assert.equal(shared.claims.length, 2); assert.notEqual(shared.claims[0], shared.claims[1]);
  assert.equal(f.calls[0].input, f.calls[1].input, 'pass identity belongs to coordination, not the unchanged model prompt');
  const afterSecond = await readFile(file, 'utf8'); await service.status(f.root, f.request);
  assert.equal(await readFile(file, 'utf8'), afterSecond); assert.equal(f.calls.length, 2);
  assert.equal(await readFile(f.oldPath, 'utf8'), f.oldBytes);
});

test('an unfinished shared pass imports an available batch once and leaves the remaining openings pending without a model call', async t => {
  const f = await fixture(t, { count: 6, maxOutputTokens: 3000, visibility: 'shared' }), shared = sharedStore({ reuseFirstBatch: true });
  const service = f.make({ sharedAnalysis: shared.api }), first = await service.status(f.root, f.request);
  assert.equal(first.status, 'complete'); assert.equal(first.complete, false);
  assert.equal(first.coverage.processedOpeningIds.length, 2); assert.equal(first.coverage.remainingIds.length, 4);
  assert.equal(first.plans.length, 6); assert.equal(f.calls.length, 0); assert.equal(shared.claims.length, 0);
  const file = join(f.root, '.film/ai-structure-plans', `${first.taskKey}.json`), importedBytes = await readFile(file, 'utf8');
  const next = await service.status(f.root, f.request); await service.status(f.root, f.request);
  assert.equal(next.confirmation?.openingCount, 4); assert.equal(next.complete, false);
  assert.equal(await readFile(file, 'utf8'), importedBytes); assert.equal(f.calls.length, 0);
  const saved = JSON.parse(importedBytes); assert.equal(saved.rounds.length, 1); assert.equal(saved.pass.number, 1);
});
