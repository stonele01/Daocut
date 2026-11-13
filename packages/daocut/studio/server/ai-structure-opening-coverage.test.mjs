import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { createAiStructurePlans } from './ai-structure-plans.mjs';
import { aiStructurePrompt, createAiStructureRequest } from './ai-structure.mjs';
import { AI_STRUCTURE_ORDER_VERSION as AI_STRUCTURE_VERSION, inspectAiOrderInput, validateAiStructureOrder } from './ai-structure-order.mjs';
import { sharedHash } from './shared-analysis.mjs';

const base = resolve(import.meta.dirname, '../../../../.tmp/opening-coverage-tests');
function material(openingCount = 10) {
  const scope = { sourceId: 's', productId: 'p', intervalId: 'i', startMs: 0, endMs: (openingCount + 1) * 15000 };
  const cues = Array.from({ length: openingCount + 1 }, (_, n) => ({ text: `完整模拟原话${n}`, startMs: n * 15000, endMs: n * 15000 + 13000 }));
  const candidates = cues.map((cue, n) => ({ ...scope, ...cue, id: `speech-${n}`, cueRange: [n, n], tags: [n === openingCount ? '行动指令' : n < 2 ? '卖点' : '痛点'],
    details: { composition: { contract: 'complete-speech-v1', status: 'confirmed', roles: [n === openingCount ? 'purchase' : n < 2 ? 'core' : 'pain'], requires: [], excludes: [], conditions: {} } } }));
  return { source: { id: 's', assetPath: 'assets/mock.mp4' }, scope, context: scope, visibility: 'local', analysisVersion: 'analysis-original', semanticVersion: 'semantic-original', engineInput: { scope, sourceIdentity: 'synthetic', candidates, cues }, issues: [] };
}
function answer(body, ids = body.openingIds) {
  const end = body.units.find(unit => unit.roles.includes('purchase')).id;
  const cores = body.units.filter(unit => unit.roles.includes('core'));
  return { schema: AI_STRUCTURE_VERSION, plans: ids.map(id => [id, cores.find(unit => unit.id !== id).id, end]) };
}
async function fixture(t, respond = body => answer(body), count = 10) {
  await mkdir(base, { recursive: true }); const root = await mkdtemp(join(base, 'case-'));
  t.mock.method(globalThis, 'fetch', () => { throw Error('Network forbidden'); });
  const input = material(count), calls = [], services = [];
  // v4 is historical: preserve its bounded continuation behavior from an
  // already-saved empty round instead of creating a first old-version request.
  const key = sharedHash({ kind: AI_STRUCTURE_VERSION, prompt: aiStructurePrompt(AI_STRUCTURE_VERSION), analysis: input.analysisVersion,
    semantic: input.semanticVersion, input: inspectAiOrderInput(input.engineInput).inputHash, visibility: input.visibility });
  const response = { schema: AI_STRUCTURE_VERSION, plans: [] };
  await mkdir(join(root, '.film/ai-structure-plans'), { recursive: true });
  await writeFile(join(root, '.film/ai-structure-plans', `${key}.json`), JSON.stringify({ version: AI_STRUCTURE_VERSION, key, sourceId: input.source.id,
    rounds: [{ status: 'complete', submitted: true, request: createAiStructureRequest(input, { version: AI_STRUCTURE_VERSION }), response, result: validateAiStructureOrder(input, response) }] }));
  const make = (extra = {}) => { const service = createAiStructurePlans({ readInput: async () => structuredClone(input), modelIdentity: { provider: 'mock', model: 'fixture-model' },
    modelClient: async args => { const body = JSON.parse(args.input); calls.push(body); return respond(body, args, calls.length); }, ...extra }); services.push(service); return service; };
  t.after(async () => { for (const service of services) await service.wait(); assert.ok(resolve(root).startsWith(base + sep)); await rm(root, { recursive: true, force: true }); });
  const request = { ...input.scope, rulesVersion: AI_STRUCTURE_VERSION };
  async function generate(service, continuation = true) { const before = await service.status(root, request); return service.generate(root, { ...request, confirmed: true, confirmationId: before.confirmation?.id, continue: continuation }); }
  return { root, input, calls, make, request, generate };
}

test('one confirmed v4 operation covers every opening across bounded batches without permutations', async t => {
  const f = await fixture(t), service = f.make();
  const preview = await service.status(f.root, f.request);
  assert.equal(f.calls.length, 0); assert.equal(preview.coverage.total, 10); assert.equal(preview.coverage.covered, 0);
  assert.equal(preview.confirmation.openingCount, 10); assert.equal(preview.confirmation.batchCount, 2); assert.equal(preview.confirmation.requestCount, 4);
  await f.generate(service); await service.wait();
  const done = await service.status(f.root, f.request);
  assert.equal(f.calls.length, 2); assert.deepEqual(f.calls.map(call => call.openingIds.length), [8, 2]);
  assert.equal(done.coverage.covered, 10); assert.equal(done.plans.length, 10); assert.equal(done.complete, true); assert.equal(done.canContinue, false);
  assert.equal(done.allValidCombinationsEnumerated, false); assert.equal(done.plans[0].speed, 1.3);
  assert(f.calls.every(call => !Object.hasOwn(call, 'transcript')));
  assert(f.calls[1].previous.length > 0);
  await f.make().status(f.root, f.request); assert.equal(f.calls.length, 2, 'reopening must only read');
});

test('omitted openings receive one correction request and are counted only after valid plans exist', async t => {
  const f = await fixture(t, (body, _args, n) => answer(body, n === 1 ? body.openingIds.slice(0, 2) : body.openingIds), 4), service = f.make();
  await f.generate(service); await service.wait();
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].openingIds.length, 2);
  const done = await service.status(f.root, f.request); assert.equal(done.coverage.covered, 4); assert.equal(done.complete, true);
});

test('invalid plans and empty replies never cover openings or terminate later opening batches', async t => {
  const f = await fixture(t, body => ({ schema: AI_STRUCTURE_VERSION, plans: body.openingIds.map(id => [id, 'unknown-id']) })), service = f.make();
  await f.generate(service); await service.wait();
  const done = await service.status(f.root, f.request);
  assert.equal(f.calls.length, 4); assert.equal(done.status, 'complete'); assert.equal(done.complete, false);
  assert.equal(done.coverage.covered, 0); assert.equal(done.coverage.remainingIds.length, 10);
  assert.equal(done.canContinue, true); assert.equal(done.plans.length, 0); assert.equal(done.confirmation.openingCount, 10);
  await service.status(f.root, f.request); await f.make().status(f.root, f.request); assert.equal(f.calls.length, 4);
});

test('partial accepted coverage survives restart and an explicit supplement targets remaining openings only', async t => {
  let partial = true;
  const f = await fixture(t, body => answer(body, partial ? body.openingIds.filter(id => id === 'speech-0') : body.openingIds), 4), service = f.make();
  await f.generate(service); await service.wait();
  const first = await service.status(f.root, f.request);
  assert.equal(first.plans.length, 1); assert.equal(first.complete, false); assert.equal(first.canContinue, true);
  partial = false; const restored = f.make(); await f.generate(restored, true); await restored.wait();
  const last = f.calls.at(-1); assert(!last.openingIds.includes('speech-0'));
  const done = await restored.status(f.root, f.request); assert.equal(done.plans.length, 4); assert.equal(done.complete, true);
  assert.equal(done.plans[0].id, first.plans[0].id);
});

test('a provider failure stops the pass and saved receipt recovery never sends or resumes a model request', async t => {
  const f = await fixture(t, async (body, args, n) => {
    const value = answer(body);
    if (n === 2) {
      const hash = value => createHash('sha256').update(value).digest('hex'), rawText = JSON.stringify(value);
      await args.onReceipt({ responseVersion: 'deepseek-text-receipt-v1', provider: 'deepseek', status: 'completed', httpStatus: 200,
        inputSha256: hash(JSON.stringify([args.system, args.input])), rawText, rawTextSha256: hash(rawText) });
      throw Error('mock connection lost after receipt');
    }
    return value;
  }), service = f.make();
  await f.generate(service); await service.wait();
  const failed = await service.status(f.root, f.request); assert.equal(failed.status, 'failed'); assert.equal(failed.plans.length, 8);
  assert.deepEqual(failed.usablePlanIds, failed.plans.map(plan => plan.id));
  const restarted = f.make(); await restarted.status(f.root, f.request); assert.equal(f.calls.length, 2);
  const recovered = await restarted.recover(f.root, f.request); assert.equal(recovered.plans.length, 10); assert.equal(recovered.complete, true); assert.equal(f.calls.length, 2);
});

test('scope edits during generation stop subsequent requests while preserving returned plans', async t => {
  let f;
  f = await fixture(t, body => { const result = answer(body); f.input.analysisVersion = 'changed'; return result; });
  const service = f.make(); await f.generate(service); await service.wait();
  assert.equal(f.calls.length, 1);
  const files = await readdir(join(f.root, '.film/ai-structure-plans'));
  const saved = JSON.parse(await readFile(join(f.root, '.film/ai-structure-plans', files[0]), 'utf8'));
  assert.equal(saved.rounds.length, 2); assert.equal(saved.rounds[0].result.plans.length, 0); assert.equal(saved.rounds[1].result.plans.length, 8);
  assert.match(saved.operationError, /话术或核查记录已变化/);
});

test('a model change between batches persists a visible stop reason and keeps accepted plans', async t => {
  let model = 'first';
  const f = await fixture(t, body => { model = 'changed'; return answer(body); });
  const service = f.make({ modelIdentity: () => ({ provider: 'mock', model }) });
  await f.generate(service); await service.wait();
  const restarted = f.make({ modelIdentity: () => ({ provider: 'mock', model }) });
  const state = await restarted.status(f.root, f.request);
  assert.equal(f.calls.length, 1); assert.equal(state.plans.length, 8);
  assert.equal(state.complete, false); assert.equal(state.canContinue, true);
  assert(state.issues.some(issue => /模型配置已变化/.test(issue.message)));
});

test('pending or dependency-only material is reported separately instead of silently counted as covered', async t => {
  const f = await fixture(t, body => answer(body), 4);
  f.input.engineInput.candidates[2].details.composition.status = 'pending';
  f.input.engineInput.candidates[3].details.composition.requires = ['speech-0'];
  const service = f.make(), state = await service.status(f.root, f.request);
  assert.equal(state.coverage.total, 2); assert.equal(state.coverage.covered, 0);
  assert(state.coverage.excluded.some(item => item.id === 'speech-2'));
  assert(state.coverage.excluded.some(item => item.id === 'speech-3'));
});
