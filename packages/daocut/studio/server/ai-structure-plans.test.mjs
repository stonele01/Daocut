import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createAiStructureRequest, validateAiStructureResponse, AI_STRUCTURE_PROMPT } from './ai-structure.mjs';
import * as aiStructure from './ai-structure.mjs';
import { AI_STRUCTURE_ORDER_VERSION, inspectAiOrderInput, validateAiStructureOrder } from './ai-structure-order.mjs';
import { COMPOSE_STRUCTURE_PROMPT, PREVIOUS_COMPOSE_STRUCTURE_PROMPT } from './approved-prompts.mjs';
import { inspectAiCompositionInput } from './structure-composition.mjs';
import { createAiStructurePlans } from './ai-structure-plans.mjs';
import { sharedHash } from './shared-analysis.mjs';
import { createHash } from 'node:crypto';
import { createDesktopAnalysisServices } from './desktop-analysis-services.mjs';

const base = resolve(import.meta.dirname, '../../../../.tmp/ai-structure-tests');
function input() {
  const roles = [['pain'], ['story'], ['core'], ['core'], ['offer', 'purchase'], ['purchase']];
  const texts = ['头发打结梳不开吗', '我早上梳头也很费劲', '完整卖点甲及必要上下文', '完整卖点乙', '两瓶九十八，只有领券才是这个价，需要的拍两瓶', '需要的点链接购买'];
  const cues = texts.map((text, i) => ({ text, startMs: i * 10000, endMs: i * 10000 + 9000 }));
  const scope = { sourceId: 's', productId: 'p', intervalId: 'i', startMs: 0, endMs: 60000 };
  const candidates = cues.map((c, i) => ({ ...c, id: `c${i}`, ...scope, startMs: c.startMs, endMs: c.endMs, cueRange: [i, i], tags: ['痛点', '故事', '卖点', '卖点', '福利机制', '行动指令'].slice(i, i + 1), details: { composition: { contract: 'complete-speech-v1', status: 'confirmed', roles: roles[i], requires: [], excludes: [], conditions: {} } } }));
  for (const candidate of candidates) {
    candidate.details.composition.openingPolicy = 'curated-openings-v1';
    if (!candidate.details.composition.roles.includes('purchase')) candidate.details.composition.opening = { group: candidate.id, followup: `回应${candidate.text}` };
  }
  return { source: { id: 's', assetPath: 'assets/synthetic.mp4' }, context: scope, scope, visibility: 'local', analysisVersion: 'saved-original', semanticVersion: 'saved-semantics', engineInput: { scope, sourceIdentity: 'synthetic-only', candidates, cues }, issues: [] };
}
const response = (plans = [[0, 2, 4]], complete = true) => ({ schema: 'ai-structure-plans-v1', plans, complete, issues: [] });
const rangeResponse = (plans = [[0, 2, 4]], complete = true) => ({ schema: 'ai-structure-plans-v3', plans: plans.map(row => row.map(unit => ({ unit, firstCue: unit, lastCue: unit,
  tags: [['痛点'], ['故事'], ['卖点'], ['卖点'], ['福利机制', '行动指令'], ['行动指令']][unit] }))), complete, issues: [] });
const orderResponse = (plans = [[0, 2, 4]]) => ({ schema: aiStructure.AI_STRUCTURE_VERSION, prices: [2, 3].map(n => ({ id: `c${n}`, kind: 'current', evidence: [n] })), plans: plans.map(row => row.map(unit => `c${unit}`)) });
async function fixture(t, client, { shared = false } = {}) {
  await mkdir(base, { recursive: true }); const root = await mkdtemp(join(base, 'case-'));
  t.after(async () => { assert.ok(resolve(root).startsWith(base + sep)); await rm(root, { recursive: true, force: true }); });
  t.mock.method(globalThis, 'fetch', () => { throw Error('Real model/network forbidden'); });
  await mkdir(join(root, '.film')); await writeFile(join(root, 'film.html'), 'existing finished film');
  const material = input(); if (shared) material.visibility = 'shared';
  for (const candidate of material.engineInput.candidates.filter(c => c.details.composition.roles.includes('core'))) {
    candidate.details.composition.roles.push('intro', 'price');
    candidate.details.composition.price = { kind: 'current', evidence: [0] };
  }
  // Service fixtures are distinct synthetic 13-second speeches: three play for 30 seconds at 1.3x.
  material.scope.endMs = 90000;
  for (const [n, cue] of material.engineInput.cues.entries()) { cue.startMs = n * 15000; cue.endMs = cue.startMs + 13000; }
  for (const [n, candidate] of material.engineInput.candidates.entries()) { candidate.startMs = material.engineInput.cues[n].startMs; candidate.endMs = material.engineInput.cues[n].endMs; }
  let calls = 0, model = { provider: 'mock', model: 'fake-ai', endpoint: 'https://mock.invalid/responses' };
  const services = [];
  const make = (extra = {}) => {
    const service = createAiStructurePlans({ readInput: async () => structuredClone(material), modelIdentity: async () => model,
      modelClient: async args => { calls++; return client(args); }, ...extra }); services.push(service); return service;
  };
  t.after(async () => { for (const service of services) await service.wait(); });
  const confirm = async (service, extra = {}) => { const state = await service.status(root, material.scope); return service.generate(root, { ...material.scope, ...extra, confirmed: true, confirmationId: state.confirmation?.id }); };
  return { root, material, make, confirm, calls: () => calls, changeModel: () => { model = { ...model, model: 'changed' }; } };
}
async function currentFixture(t, client, options) {
  const f = await fixture(t, client, options);
  // Receipt, publication and concurrency cases concern one independently usable
  // opening. Multi-opening adaptive passes are exercised by the workflow suite.
  for (const candidate of f.material.engineInput.candidates.slice(1, 4)) candidate.details.composition.requires = ['c0'];
  return f;
}

test('the current prompt supplies complete speech and applicable checks without repeating the transcript', () => {
  const f = input(); f.visualReview = { status: 'complete', entries: [{ startMs: 0, endMs: 60000, observation: '模拟画面见产品' }] };
  const request = createAiStructureRequest(f);
  assert.match(AI_STRUCTURE_PROMPT, /开头.*后文|后文.*开头/); assert.match(AI_STRUCTURE_PROMPT, /价格对比/);
  assert.match(AI_STRUCTURE_PROMPT, /每个指定开头累计最多3条/); assert.match(AI_STRUCTURE_PROMPT, /JSON/);
  const body = JSON.parse(request.input);
  assert.equal(Object.hasOwn(body, 'transcript'), true); assert.equal(body.units.length, 6);
  assert.deepEqual(body.openingIds, ['c0', 'c1', 'c2', 'c3']);
  assert.ok(body.units.every(unit => typeof unit.id === 'string' && Array.isArray(unit.roles) && unit.durationMs === 9000));
  assert.match(request.input, /完整卖点甲及必要上下文/); assert.match(request.input, /模拟画面见产品/);
  assert.ok(!request.input.includes('assets/')); assert.ok(!request.input.includes('apiKey'));
});

test('public AI input stays the same across personal names and supplemental visual checks', () => {
  const f = input(); f.visibility = 'shared'; f.compositionEvidence = { visualReview: { status: 'complete', entries: [{ startMs: 0, endMs: 60000, observation: '公共画面记录' }] } };
  const before = createAiStructureRequest(f);
  f.visualReview = { status: 'complete', entries: [{ observation: '个人画面补查' }] }; f.visualReviewStale = true;
  assert.deepEqual(createAiStructureRequest(f), before);
  assert.match(before.input, /公共画面记录/); assert.doesNotMatch(before.input, /个人画面补查/);
});

test('legacy records also keep every purchase clip at the end; duration is not capped at fifty seconds', () => {
  const f = input();
  for (const c of f.engineInput.candidates) { delete c.details.composition.contract; c.details.composition.coreIds = c.details.composition.roles.includes('core') ? [c.id] : []; }
  f.engineInput.candidates[0].details.composition.roles = ['hook'];
  assert.equal(validateAiStructureResponse(f, response([[0, 2, 4, 5]])).plans.length, 0);
  f.engineInput.candidates[0].details.composition.roles = ['pain'];
  assert.equal(validateAiStructureResponse(f, response([[0, 2, 4]])).plans.length, 1, 'a verified complete pain can open, including a legacy record');
  for (const n of [0, 2, 3]) { f.engineInput.candidates[n].details.composition.roles = ['core']; f.engineInput.candidates[n].details.composition.coreIds = ['same-benefit']; }
  assert.equal(validateAiStructureResponse(f, response([[0, 2, 3, 4]])).plans.length, 0, 'three complete selling speeches cannot pass as one just because old IDs match');
  const long = input(); long.scope.endMs = long.engineInput.scope.endMs = 180000;
  for (const c of [...long.engineInput.candidates, ...long.engineInput.cues]) { c.startMs *= 3; c.endMs *= 3; }
  assert.equal(validateAiStructureResponse(long, response()).plans[0].durationMs, 81000);
});

test('third-prompt requests reuse the desktop model bridge and receipt callback, with no provider request', async t => {
  const f = await currentFixture(t, async () => { throw Error('unused adapter'); });
  let executions = 0;
  const services = createDesktopAnalysisServices({ env: {}, providersFile: join(f.root, 'unused-providers.json'), textBridge: async message => {
    if (message.operation === 'public-config') return { id: 'mock-config', name: '模拟 DeepSeek', baseUrl: 'https://mock.invalid', model: 'simulated-model' };
    assert.equal(message.operation, 'execute'); assert.equal(message.system, AI_STRUCTURE_PROMPT); assert.match(message.input, /完整卖点甲/);
    executions++; return { value: orderResponse(), receipt: { requestId: 'mock-structure-receipt', status: 'completed' } };
  } });
  const service = f.make({ modelClient: services.liveAnalysis.modelClient, modelIdentity: undefined });
  await f.confirm(service); await service.wait();
  assert.equal((await service.status(f.root, f.material.scope)).plans.length, 1); assert.equal(executions, 1);
  const files = await readdir(join(f.root, '.film/ai-structure-plans'));
  const saved = JSON.parse(await readFile(join(f.root, '.film/ai-structure-plans', files[0]), 'utf8'));
  assert.equal(saved.rounds[0].receipt.requestId, 'mock-structure-receipt');
});

test('only AI-selected sequences become plans: order and whole quotes stay intact; no program enumeration or duration cap', () => {
  const f = input(), result = validateAiStructureResponse(f, response([[1, 3, 2, 4], [0, 2, 5], [1, 3, 2, 4]]));
  assert.deepEqual(result.plans.map(p => p.clips.map(c => c.candidateId)), [['c1', 'c3', 'c2', 'c4'], ['c0', 'c2', 'c5']]);
  assert.equal(result.plans[0].durationMs, 36000); assert.equal(result.plans[1].durationMs, 27000);
  assert.equal(result.plans[0].clips.at(-1).text, f.engineInput.candidates[4].text);
  assert.ok(result.plans.every(p => p.speed === 1 && p.generationMethod === 'ai'));
  assert.equal(result.allValidCombinationsEnumerated, false);
});

test('invalid AI sequences are reported, never repaired by inventing lines or automatic permutations', () => {
  const f = input(); f.engineInput.candidates[3].details.composition.conditions = { quantity: 1 }; f.engineInput.candidates[4].details.composition.conditions = { quantity: 2 };
  const result = validateAiStructureResponse(f, response([[0, 2], [4, 2, 5], [0, 5], [0, 99, 5], [0, 2, 2, 5], [0, 3, 4]]));
  assert.equal(result.plans.length, 0); assert.equal(result.issues.length, 6);
  assert.throws(() => validateAiStructureResponse(f, { ...response(), plans: [{ text: '编造台词' }] }), /片段编号/);
  const pending = input(); pending.engineInput.candidates[2].details.composition.status = 'pending';
  assert.equal(validateAiStructureResponse(pending, response()).plans.length, 0);
});

test('no fixed count: every distinct valid AI sequence survives and continuation keeps earlier plans', () => {
  const rows = []; for (const h of [0, 1]) for (const c of [2, 3]) for (const end of [4, 5]) rows.push([h, c, end]);
  const first = validateAiStructureResponse(input(), response(rows, false)); assert.equal(first.plans.length, 8);
  const next = createAiStructureRequest(input(), { previous: first.sequences, version: 'ai-structure-plans-v1' }); assert.equal(JSON.parse(next.input).previous.length, 8);
  const long = input(); long.engineInput.candidates[2].endMs = 39000; long.engineInput.candidates[2].cueRange = [2, 3]; long.engineInput.candidates[2].text += long.engineInput.candidates[3].text;
  assert.equal(validateAiStructureResponse(long, response([[0, 2, 4]])).plans[0].durationMs, 37000);
});

test('click planning is read-only; explicit frozen confirmation makes one AI call; reopening reuses results and original film', async t => {
  const f = await currentFixture(t, async () => orderResponse()), service = f.make();
  const state = await service.status(f.root, f.material.scope); assert.equal(state.status, 'idle'); assert.equal(f.calls(), 0);
  await assert.rejects(service.generate(f.root, f.material.scope), /确认/); assert.equal(f.calls(), 0);
  f.changeModel(); await assert.rejects(service.generate(f.root, { ...f.material.scope, confirmed: true, confirmationId: state.confirmation.id }), /变化|确认/);
  await Promise.all([f.confirm(service), f.confirm(service)]); await service.wait();
  const done = await service.status(f.root, f.material.scope); assert.equal(done.status, 'complete'); assert.equal(done.plans.length, 1); assert.equal(f.calls(), 1);
  assert.equal(done.version, aiStructure.AI_STRUCTURE_VERSION); assert.equal(done.canContinue, true);
  assert.equal(done.coverage.covered, 1); assert.deepEqual(done.coverage.remainingIds, []);
  assert.equal((await f.make().status(f.root, f.material.scope)).plans[0].id, done.plans[0].id);
  await f.confirm(service); assert.equal(f.calls(), 1);
  assert.equal(await readFile(join(f.root, 'film.html'), 'utf8'), 'existing finished film');
});

test('saved v3 continuation is another explicit request and cannot overwrite its prior round', async t => {
  const requests = [];
  const f = await fixture(t, async args => { assert.equal(args.system, COMPOSE_STRUCTURE_PROMPT); requests.push(JSON.parse(args.input)); return rangeResponse([[1, 3, 5]]); });
  const old = await seedRange(f, 'ai-structure-plans-v3', 'complete', false), s = f.make(), selected = { ...f.material.scope, taskKey: old.key };
  const first = await s.status(f.root, selected); assert.equal(first.canContinue, true);
  await s.status(f.root, selected); assert.equal(f.calls(), 0);
  await s.generate(f.root, { ...selected, continue: true, confirmed: true, confirmationId: first.confirmation.id }); await s.wait();
  const done = await s.status(f.root, selected); assert.equal(done.plans.length, 2); assert.equal(done.canContinue, false); assert.equal(f.calls(), 1);
  assert.deepEqual(requests[0].previous, rangeResponse().plans); assert.equal(done.plans[0].id, first.plans[0].id);
});

test('unknown or incomplete response never auto resends; complete saved response recovers without another model call', async t => {
  for (const complete of [false, true]) await t.test(String(complete), async t => {
    const f = await currentFixture(t, async args => {
      if (complete) {
        const digest = text => createHash('sha256').update(text).digest('hex'), rawText = JSON.stringify(orderResponse());
        await args.onReceipt({ responseVersion: 'deepseek-text-receipt-v1', provider: 'deepseek', status: 'completed', httpStatus: 200,
          inputSha256: digest(JSON.stringify([args.system, args.input])), rawText, rawTextSha256: digest(rawText) });
      }
      throw Object.assign(Error('mock connection lost'), { code: 'MODEL_NETWORK' });
    }), s = f.make();
    await f.confirm(s); await s.wait();
    const failed = await s.status(f.root, f.material.scope); assert.equal(failed.status, 'failed');
    const again = f.make(); await f.confirm(again); await again.wait(); assert.equal(f.calls(), 1);
    const recovered = await again.recover(f.root, f.material.scope);
    assert.equal(recovered.status, complete ? 'complete' : 'failed'); assert.equal(f.calls(), 1);
  });
});

test('disk failure after the response does not crash the background job or resend; saved receipt restores offline', async t => {
  let diskFull = false;
  const f = await currentFixture(t, async args => {
    const digest = text => createHash('sha256').update(text).digest('hex'), rawText = JSON.stringify(orderResponse());
    await args.onReceipt({ responseVersion: 'deepseek-text-receipt-v1', provider: 'deepseek', status: 'completed', httpStatus: 200,
      inputSha256: digest(JSON.stringify([args.system, args.input])), rawText, rawTextSha256: digest(rawText) });
    diskFull = true; return orderResponse();
  });
  const s = f.make({ saveRecord: async (root, key, data) => {
    if (diskFull) throw Error('mock disk full');
    await mkdir(join(root, '.film/ai-structure-plans'), { recursive: true });
    await writeFile(join(root, '.film/ai-structure-plans', `${key}.json`), JSON.stringify(data));
  } });
  await f.confirm(s); await s.wait();
  const interrupted = await s.status(f.root, f.material.scope);
  assert.equal(interrupted.status, 'failed'); assert.equal(interrupted.recoverable, true);
  assert.ok(interrupted.issues.some(i => i.message.includes('mock disk full')));
  diskFull = false;
  const restored = await s.recover(f.root, f.material.scope);
  assert.equal(restored.status, 'complete'); assert.equal(restored.plans.length, 1); assert.equal(f.calls(), 1);
});

test('shared AI results are claimed once, reused by colleagues, and publication failure only needs saving', async t => {
  const tasks = new Map(); let claims = 0, offline = true;
  const shared = { validateSource: async () => {}, prepareExisting: async (_root, _source, artifact) => {
    const taskKey = sharedHash(artifact.payload), found = tasks.get(taskKey);
    return { taskKey, mode: found?.payload ? 'reuse' : found ? 'busy' : 'publish' };
  }, acquire: async d => { if (tasks.has(d.taskKey)) throw Error('Already claimed'); claims++; tasks.set(d.taskKey, {}); return { attemptId: 'attempt' }; },
  complete: async (_root, d, _attempt, payload) => { if (offline) throw Error('mock offline'); tasks.get(d.taskKey).payload = structuredClone(payload); },
  read: async (_root, d) => ({ payload: tasks.get(d.taskKey).payload }), fail: async () => {}, publish: async () => { throw Error('没有可补保存的本机 AI 结果'); } };
  let release; const pendingResponse = new Promise(done => { release = done; });
  const f = await currentFixture(t, async () => { await pendingResponse; return orderResponse(); }, { shared: true }), s = f.make({ sharedAnalysis: shared });
  const other = join(f.root, 'colleague'); await mkdir(other);
  const colleague = f.make({ sharedAnalysis: shared });
  const a = await s.status(f.root, f.material.scope), b = await colleague.status(other, f.material.scope);
  const submissions = await Promise.allSettled([
    s.generate(f.root, { ...f.material.scope, confirmed: true, confirmationId: a.confirmation.id }),
    colleague.generate(other, { ...f.material.scope, confirmed: true, confirmationId: b.confirmation.id }),
  ]);
  try {
    assert.equal(submissions.filter(r => r.status === 'fulfilled' && r.value.status === 'running').length, 1);
    assert.equal(claims, 1);
  } finally { release(); }
  await s.wait(); await colleague.wait(); assert.equal(f.calls(), 1);
  const generatedRoot = submissions[0].status === 'fulfilled' && submissions[0].value.status === 'running' ? f.root : other;
  const generatedService = generatedRoot === f.root ? s : colleague;
  const pending = await generatedService.status(generatedRoot, f.material.scope); assert.equal(pending.status, 'publish-pending');
  assert.ok(pending.issues.some(i => i.message.includes('mock offline')));
  offline = false; await generatedService.publish(generatedRoot, { sourceId: 's', taskKey: pending.taskKey, confirmed: true }); assert.equal(f.calls(), 1);
  const reused = await f.make({ sharedAnalysis: shared }).status(generatedRoot === f.root ? other : f.root, f.material.scope);
  assert.equal(reused.status, 'complete'); assert.equal(reused.plans.length, 1); assert.equal(claims, 1); assert.equal(f.calls(), 1);
});

test('saved v4 continuation claims the first shared batch before reporting running', async t => {
  let release, claims = 0;
  const gate = new Promise(resolve => { release = resolve; }), tasks = new Map();
  const f = await currentFixture(t, async request => {
    assert.equal(request.system, aiStructure.aiStructurePrompt(AI_STRUCTURE_ORDER_VERSION));
    await gate; return { schema: AI_STRUCTURE_ORDER_VERSION, plans: [['c0', 'c2', 'c4']] };
  }, { shared: true });
  const other = join(f.root, 'colleague'); await mkdir(other);
  const key = sharedHash({ kind: AI_STRUCTURE_ORDER_VERSION, prompt: aiStructure.aiStructurePrompt(AI_STRUCTURE_ORDER_VERSION),
    analysis: f.material.analysisVersion, semantic: f.material.semanticVersion, input: inspectAiOrderInput(f.material.engineInput).inputHash, visibility: f.material.visibility });
  const response = { schema: AI_STRUCTURE_ORDER_VERSION, plans: [] };
  const seed = { version: AI_STRUCTURE_ORDER_VERSION, key, sourceId: 's', rounds: [{ status: 'complete', submitted: true,
    request: createAiStructureRequest(f.material, { version: AI_STRUCTURE_ORDER_VERSION }), response, result: validateAiStructureOrder(f.material, response) }] };
  for (const root of [f.root, other]) {
    await mkdir(join(root, '.film/ai-structure-plans'), { recursive: true });
    await writeFile(join(root, '.film/ai-structure-plans', `${key}.json`), JSON.stringify(seed));
  }
  const shared = { validateSource: async () => {}, prepareExisting: async (_root, _source, artifact) => {
    const taskKey = sharedHash(artifact.payload), task = tasks.get(taskKey);
    return { taskKey, mode: task?.payload ? 'reuse' : task ? 'busy' : 'publish' };
  }, acquire: async descriptor => {
    if (tasks.has(descriptor.taskKey)) throw Error('Already claimed');
    claims++; tasks.set(descriptor.taskKey, {}); return { attemptId: 'old-v4-attempt' };
  }, complete: async (_root, descriptor, _attempt, payload) => { tasks.get(descriptor.taskKey).payload = structuredClone(payload); },
  read: async (_root, descriptor) => ({ payload: tasks.get(descriptor.taskKey).payload }) };
  const a = f.make({ sharedAnalysis: shared }), b = f.make({ sharedAnalysis: shared });
  const selected = { ...f.material.scope, rulesVersion: AI_STRUCTURE_ORDER_VERSION, taskKey: key };
  const previews = await Promise.all([a.status(f.root, selected), b.status(other, selected)]);
  const submitted = await Promise.allSettled([a.generate(f.root, { ...selected, confirmed: true, continue: true, confirmationId: previews[0].confirmation.id }),
    b.generate(other, { ...selected, confirmed: true, continue: true, confirmationId: previews[1].confirmation.id })]);
  try {
    assert.equal(submitted.filter(item => item.status === 'fulfilled' && item.value.status === 'running').length, 1);
    assert.equal(claims, 1);
  } finally { release(); }
  await a.wait(); await b.wait(); assert.equal(f.calls(), 1);
  const first = await a.status(f.root, selected), second = await b.status(other, selected);
  assert.equal(first.plans.length, 1); assert.deepEqual(second.plans, first.plans); assert.equal(f.calls(), 1);
});

function legacyIdentity(material) {
  const version = 'ai-structure-plans-v1', prompt = aiStructure.PREVIOUS_AI_STRUCTURE_PROMPT ?? AI_STRUCTURE_PROMPT;
  const inspected = inspectAiCompositionInput(material.engineInput);
  const key = sharedHash({ kind: version, prompt, analysis: material.analysisVersion, semantic: material.semanticVersion, input: inspected.inputHash, visibility: material.visibility });
  const request = createAiStructureRequest(material, { version });
  return { version, key, request };
}
async function seedLegacy(f, status, { receiptOnly = false } = {}) {
  const old = legacyIdentity(f.material), value = response();
  const digest = text => createHash('sha256').update(text).digest('hex'), rawText = JSON.stringify(value);
  const round = { status, submitted: true, request: old.request, ...(receiptOnly ? { receipt: { responseVersion: 'deepseek-text-receipt-v1', provider: 'deepseek', status: 'completed', httpStatus: 200,
    inputSha256: digest(JSON.stringify([old.request.system, old.request.input])), rawText, rawTextSha256: digest(rawText) } } : { response: value }),
    ...(status === 'complete' ? { result: validateAiStructureResponse(f.material, value) } : {}) };
  const saved = { version: old.version, key: old.key, sourceId: 's', rounds: [round] }, path = join(f.root, '.film/ai-structure-plans', `${old.key}.json`);
  await mkdir(join(f.root, '.film/ai-structure-plans'), { recursive: true }); await writeFile(path, JSON.stringify(saved));
  return { ...old, path, saved };
}

test('saved v3 child ranges preserve their 1.3 speed and can open inside a mixed purchase mother', async t => {
  const f = await fixture(t, async () => { throw Error('Historical ranges are reopened without a model'); });
  // A long mother may contain purchase while the selected complete child can open.
  f.material.engineInput.candidates[0].details.composition.roles = ['pain', 'purchase'];
  f.material.engineInput.candidates[1].details.composition.roles = ['story', 'purchase'];
  f.material.engineInput.candidates[2].details.composition.roles = ['core', 'purchase'];
  f.material.engineInput.candidates[3].details.composition.roles = ['core', 'purchase'];
  const old = await seedRange(f, 'ai-structure-plans-v3'), before = await readFile(old.path, 'utf8');
  const done = await f.make().status(f.root, { ...f.material.scope, taskKey: old.key });
  assert.equal(done.status, 'complete'); assert.equal(done.plans[0].speed, 1.3); assert.equal(done.plans[0].durationMs, 30000);
  const saved = JSON.parse(await readFile(join(f.root, '.film/ai-structure-plans', `${done.taskKey}.json`), 'utf8'));
  assert.equal(saved.version, 'ai-structure-plans-v3'); assert.equal(saved.rounds[0].response.schema, saved.version); assert.equal(f.calls(), 0);
  assert.equal(await readFile(old.path, 'utf8'), before);
});

test('a v1 response to a new v5 request stays failed and recover never accepts a schema downgrade', async t => {
  const f = await fixture(t, async () => response()), service = f.make();
  await f.confirm(service); await service.wait();
  const failed = await service.status(f.root, f.material.scope); assert.equal(failed.status, 'failed'); assert.equal(failed.plans.length, 0);
  const recovered = await service.recover(f.root, f.material.scope); assert.equal(recovered.status, 'failed'); assert.equal(recovered.plans.length, 0); assert.equal(f.calls(), 1);
});

test('old complete results retain their key, speed and original bytes; opening v2 does not request regeneration', async t => {
  const f = await fixture(t, async () => { throw Error('Legacy result must be reused'); }), old = await seedLegacy(f, 'complete');
  const before = await readFile(old.path, 'utf8'), service = f.make(), state = await service.status(f.root, f.material.scope);
  assert.equal(state.status, 'complete'); assert.equal(state.taskKey, old.key); assert.equal(state.plans[0].speed, 1); assert.equal(state.plans[0].durationMs, 39000);
  await f.confirm(service); assert.equal(f.calls(), 0); assert.equal(await readFile(old.path, 'utf8'), before);
  assert.deepEqual(await readdir(join(f.root, '.film/ai-structure-plans')), [`${old.key}.json`]);
});

test('a saved legacy receipt recovers with the frozen v1 request and version, with no resend or v2 copy', async t => {
  const f = await fixture(t, async () => { throw Error('Do not resend'); }), old = await seedLegacy(f, 'failed', { receiptOnly: true });
  const service = f.make(); assert.equal((await service.status(f.root, f.material.scope)).status, 'failed');
  const state = await service.recover(f.root, f.material.scope);
  assert.equal(state.status, 'complete'); assert.equal(state.taskKey, old.key); assert.equal(state.plans[0].version, old.version); assert.equal(state.plans[0].speed, 1); assert.equal(f.calls(), 0);
  const saved = JSON.parse(await readFile(old.path, 'utf8')); assert.equal(saved.version, old.version); assert.equal(saved.rounds[0].request.system, old.request.system);
  assert.deepEqual(await readdir(join(f.root, '.film/ai-structure-plans')), [`${old.key}.json`]);
});

test('legacy publication recovery keeps its original wrapper and body version without calling the model', async t => {
  const f = await fixture(t, async () => { throw Error('No model for publication recovery'); }, { shared: true }), old = await seedLegacy(f, 'publish-pending');
  old.saved.rounds[0].descriptor = { taskKey: 'old-outbox', mode: 'publish-pending' };
  old.saved.rounds[0].attemptId = 'original-attempt';
  await writeFile(old.path, JSON.stringify(old.saved));
  const published = [];
  const shared = { complete: async (_root, descriptor, attemptId, payload) => { published.push({ descriptor, attemptId, payload }); } };
  const state = await f.make({ sharedAnalysis: shared }).publish(f.root, { sourceId: 's', taskKey: old.key, confirmed: true });
  assert.equal(state.status, 'complete'); assert.equal(published.length, 1); assert.equal(published[0].attemptId, 'original-attempt');
  assert.equal(published[0].payload.schema, old.version); assert.equal(published[0].payload.response.schema, old.version);
  assert.equal(published[0].payload.requestHash, sharedHash(old.request)); assert.equal(f.calls(), 0);
  const stored = JSON.parse(await readFile(old.path, 'utf8')); assert.equal(stored.version, old.version); assert.equal(stored.rounds[0].status, 'complete');
});

test('a colleague discovers an existing v1 public task even without any local record, never claims a v2 replacement', async t => {
  const f = await fixture(t, async () => { throw Error('Do not regenerate public v1'); }, { shared: true }), old = legacyIdentity(f.material);
  let claims = 0, probes = [], reads = 0;
  const shared = { validateSource: async () => {}, prepareExisting: async (_root, _source, artifact) => {
    probes.push(artifact.payload.kind); return artifact.payload.kind === old.version ? { mode: 'reuse', taskKey: 'legacy-public' } : { mode: 'publish', taskKey: 'new-public' };
  }, read: async () => { reads++; return { payload: { schema: old.version, requestHash: sharedHash(old.request), response: response() } }; },
  acquire: async () => { claims++; throw Error('Must not claim'); } };
  const state = await f.make({ sharedAnalysis: shared }).status(f.root, f.material.scope);
  assert.equal(state.status, 'complete'); assert.equal(state.taskKey, old.key); assert.equal(state.plans[0].speed, 1); assert.equal(reads, 1); assert.equal(claims, 0); assert.equal(f.calls(), 0);
  assert.deepEqual(probes, ['ai-structure-plans-v7', 'ai-structure-plans-v6', 'ai-structure-plans-v5', 'ai-structure-plans-v4', 'ai-structure-plans-v3', 'ai-structure-plans-v2', old.version]);
});

test('an uncertain or unreadable old public task blocks a new paid request and reports the recovery gap', async t => {
  for (const mode of ['busy', 'unreadable']) await t.test(mode, async t => {
    const f = await fixture(t, async () => { throw Error('Do not send while legacy state is unknown'); }, { shared: true });
    let probes = 0, claims = 0;
    const shared = { validateSource: async () => {}, prepareExisting: async (_root, _source, artifact) => {
      probes++; if (artifact.payload.kind === 'ai-structure-plans-v1') { if (mode === 'unreadable') throw Error('mock old task unavailable'); return { mode: 'busy', taskKey: 'old' }; }
      return { mode: 'publish', taskKey: 'new' };
    }, acquire: async () => { claims++; throw Error('Must not claim'); } };
    const service = f.make({ sharedAnalysis: shared }), state = await service.status(f.root, f.material.scope);
    assert.ok(['busy', 'unavailable'].includes(state.status)); assert.equal(state.confirmation, undefined); assert.ok(state.issues.some(issue => /已有提交|旧|尚未|无法|核查/.test(issue.message)));
    await service.generate(f.root, { ...f.material.scope, confirmed: true, confirmationId: 'not-valid' });
    assert.equal(probes, 14); assert.equal(claims, 0); assert.equal(f.calls(), 0);
  });
});

test('a missing legacy public artifact reports a recovery issue and cannot fall through into a new request', async t => {
  const f = await fixture(t, async () => { throw Error('No regeneration'); }, { shared: true }); let claims = 0;
  const shared = { validateSource: async () => {}, prepareExisting: async () => ({ mode: 'reuse', taskKey: 'old' }),
    read: async () => { throw Error('mock saved public result unavailable'); }, acquire: async () => { claims++; throw Error('No claim'); } };
  const service = f.make({ sharedAnalysis: shared });
  for (const state of [await service.status(f.root, f.material.scope), await service.generate(f.root, f.material.scope)]) {
    assert.equal(state.status, 'unavailable'); assert.ok(state.issues.some(issue => /mock saved public result unavailable/.test(issue.message))); assert.equal(state.confirmation, undefined);
  }
  assert.equal(claims, 0); assert.equal(f.calls(), 0);
});

const currentRules = aiStructure.AI_STRUCTURE_VERSION, oldRules = 'ai-structure-plans-v1';
test('an explicit new-rules request previews confirmation read-only, keeps v1 bytes, and lets both versions reopen by key', async t => {
  const f = await currentFixture(t, async () => orderResponse()), old = await seedLegacy(f, 'complete'), service = f.make();
  const before = await readFile(old.path, 'utf8');
  const legacy = await service.status(f.root, f.material.scope);
  assert.equal(legacy.version, oldRules); assert.equal(legacy.currentRulesVersion, currentRules);
  assert.deepEqual(legacy.savedVersions, [{ version: oldRules, taskKey: old.key }]);
  const request = { ...f.material.scope, rulesVersion: currentRules };
  const preview = await service.status(f.root, request);
  assert.equal(preview.status, 'idle'); assert.equal(preview.version, currentRules); assert.equal(preview.confirmation.rulesVersion, currentRules);
  assert.notEqual(preview.taskKey, old.key); assert.equal(f.calls(), 0);
  await assert.rejects(service.generate(f.root, request), /确认/);
  assert.deepEqual(await readdir(join(f.root, '.film/ai-structure-plans')), [`${old.key}.json`]);
  assert.equal(await readFile(old.path, 'utf8'), before, 'opening/cancelling the new confirmation never modifies v1');
  await service.generate(f.root, { ...request, confirmed: true, confirmationId: preview.confirmation.id }); await service.wait();
  const latest = await service.status(f.root, request);
  assert.equal(latest.status, 'complete'); assert.equal(latest.plans[0].speed, 1.3); assert.equal(f.calls(), 1);
  assert.deepEqual(new Map(latest.savedVersions.map(item => [item.version, item.taskKey])), new Map([[oldRules, old.key], [currentRules, latest.taskKey]]));
  const oldAgain = await f.make().status(f.root, { ...f.material.scope, taskKey: old.key });
  assert.equal(oldAgain.version, oldRules); assert.equal(oldAgain.plans[0].speed, 1);
  assert.equal((await f.make().status(f.root, { ...f.material.scope, taskKey: latest.taskKey })).plans[0].speed, 1.3);
  assert.equal((await f.make().status(f.root, f.material.scope)).version, currentRules);
  assert.equal(await readFile(old.path, 'utf8'), before);
  assert.equal(await readFile(join(f.root, 'film.html'), 'utf8'), 'existing finished film');
});

test('version selectors and task keys are scoped, and historical versions cannot create first paid requests', async t => {
  const f = await currentFixture(t, async () => orderResponse()), service = f.make(), scope = f.material.scope;
  const first = await service.status(f.root, scope); assert.equal(first.confirmation.rulesVersion, currentRules);
  for (const request of [{ ...scope, rulesVersion: 'made-up' }, { ...scope, taskKey: '0'.repeat(64) }, { ...scope, taskKey: '../outside' }, { ...scope, taskKey: first.taskKey, rulesVersion: oldRules }]) {
    await assert.rejects(service.status(f.root, request), error => error.status === 409 || error.statusCode === 409);
    await assert.rejects(service.generate(f.root, request), error => error.status === 409 || error.statusCode === 409);
  }
  for (const version of [oldRules, 'ai-structure-plans-v2', 'ai-structure-plans-v3', 'ai-structure-plans-v4']) {
    const absent = await service.status(f.root, { ...scope, rulesVersion: version });
    assert.equal(absent.status, 'unavailable'); assert.equal(absent.confirmation, undefined);
    assert.equal((await service.generate(f.root, { ...scope, rulesVersion: version, confirmed: true, confirmationId: first.confirmation.id })).status, 'unavailable');
  }
  assert.equal(f.calls(), 0);
});

test('unfinished old records block a new-rules request until the old result is recovered or published', async t => {
  for (const oldStatus of ['running', 'failed', 'unknown', 'publish-pending']) await t.test(oldStatus, async t => {
    const f = await currentFixture(t, async () => orderResponse()), old = await seedLegacy(f, oldStatus), before = await readFile(old.path, 'utf8'), service = f.make();
    const request = { ...f.material.scope, rulesVersion: currentRules };
    for (const state of [await service.status(f.root, request), await service.generate(f.root, { ...request, confirmed: true, confirmationId: 'not-a-confirmation' })]) {
      assert.equal(state.status, 'unavailable'); assert.equal(state.confirmation, undefined);
      assert.equal(state.blockedBy.taskKey, old.key); assert.equal(state.blockedBy.version, oldRules);
      assert.ok(state.issues.some(item => /恢复|补存|未完成|不明/.test(item.message)));
    }
    assert.equal(f.calls(), 0); assert.equal(await readFile(old.path, 'utf8'), before);
    if (oldStatus === 'failed') {
      assert.equal((await service.recover(f.root, { ...f.material.scope, taskKey: old.key })).status, 'complete');
      assert.equal((await service.status(f.root, request)).status, 'idle'); assert.equal(f.calls(), 0);
    }
  });
});

test('a corrupt unrelated legacy record cannot hide a saved current result or its offline recovery', async t => {
  const f = await currentFixture(t, async () => orderResponse()), service = f.make();
  await f.confirm(service); await service.wait(); const done = await service.status(f.root, f.material.scope);
  const old = legacyIdentity(f.material), oldPath = join(f.root, '.film/ai-structure-plans', `${old.key}.json`);
  await writeFile(oldPath, '{broken legacy record');
  assert.equal((await service.status(f.root, f.material.scope)).plans[0].id, done.plans[0].id);
  const currentPath = join(f.root, '.film/ai-structure-plans', `${done.taskKey}.json`), saved = JSON.parse(await readFile(currentPath, 'utf8'));
  saved.rounds[0].status = 'failed'; delete saved.rounds[0].result; await writeFile(currentPath, JSON.stringify(saved));
  const recovered = await service.recover(f.root, { ...f.material.scope, taskKey: done.taskKey });
  assert.equal(recovered.status, 'complete'); assert.equal(f.calls(), 1); assert.equal(await readFile(oldPath, 'utf8'), '{broken legacy record');
});

test('a completed legacy public task and new public task use separate identities; colleagues claim the new version once', async t => {
  const tasks = new Map(); let claims = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await currentFixture(t, async () => { await gate; return orderResponse(); }, { shared: true });
  const old = legacyIdentity(f.material), oldPayload = { schema: old.version, requestHash: sharedHash(old.request), response: response() };
  const shared = { validateSource: async () => {}, prepareExisting: async (_root, _source, artifact) => {
    if (artifact.payload.kind === oldRules) return { mode: 'reuse', taskKey: 'legacy' };
    const taskKey = sharedHash(artifact.payload), task = tasks.get(taskKey);
    return { taskKey, mode: task?.payload ? 'reuse' : task ? 'busy' : 'publish' };
  }, read: async (_root, descriptor) => ({ payload: descriptor.taskKey === 'legacy' ? structuredClone(oldPayload) : structuredClone(tasks.get(descriptor.taskKey).payload) }),
  acquire: async descriptor => { if (tasks.has(descriptor.taskKey)) throw Error('Already claimed'); claims++; tasks.set(descriptor.taskKey, {}); return { attemptId: 'new-attempt' }; },
  complete: async (_root, descriptor, _attempt, payload) => { tasks.get(descriptor.taskKey).payload = structuredClone(payload); } };
  const other = join(f.root, 'colleague'); await mkdir(other);
  const a = f.make({ sharedAnalysis: shared }), b = f.make({ sharedAnalysis: shared }), request = { ...f.material.scope, rulesVersion: currentRules };
  const first = await a.status(f.root, request), second = await b.status(other, request);
  assert.equal(first.version, currentRules); assert.equal(first.status, 'idle'); assert.equal(f.calls(), 0);
  const submitted = await Promise.allSettled([a.generate(f.root, { ...request, confirmed: true, confirmationId: first.confirmation.id }), b.generate(other, { ...request, confirmed: true, confirmationId: second.confirmation.id })]);
  try {
    assert.equal(submitted.filter(item => item.status === 'fulfilled' && item.value.status === 'running').length, 1); assert.equal(claims, 1);
  } finally { release(); }
  await a.wait(); await b.wait(); assert.equal(f.calls(), 1);
  assert.equal((await a.status(f.root, request)).plans[0].speed, 1.3); assert.equal((await b.status(other, request)).plans[0].speed, 1.3);
  assert.equal((await b.status(other, { ...f.material.scope, rulesVersion: oldRules })).plans[0].speed, 1);
  assert.equal(claims, 1); assert.equal(f.calls(), 1); assert.equal(oldPayload.schema, oldRules);
});

test('switching versions cannot start an old continuation while a new version request is still executing', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const f = await currentFixture(t, async () => { await gate; return orderResponse(); }), old = await seedLegacy(f, 'complete');
  old.saved.rounds[0].result.modelComplete = false; old.saved.rounds[0].response.complete = false; await writeFile(old.path, JSON.stringify(old.saved));
  const service = f.make(), oldScope = { ...f.material.scope, taskKey: old.key }, oldConfirmation = await service.status(f.root, oldScope);
  assert.equal(oldConfirmation.canContinue, true, 'an existing v1 continuation remains supported');
  try {
    const nextScope = { ...f.material.scope, rulesVersion: currentRules }, next = await service.status(f.root, nextScope);
    await service.generate(f.root, { ...nextScope, confirmed: true, confirmationId: next.confirmation.id });
    const blocked = await service.generate(f.root, { ...oldScope, continue: true, confirmed: true, confirmationId: oldConfirmation.confirmation.id });
    assert.equal(blocked.status, 'busy'); assert.equal(f.calls(), 1);
  } finally { release(); }
  await service.wait(); assert.equal(f.calls(), 1);
  assert.equal(JSON.parse(await readFile(old.path, 'utf8')).rounds.length, 1);
});

test('unknown or empty saved legacy records expose recovery instead of becoming a first v1 request', async t => {
  const f = await fixture(t, async () => { throw Error('Never resend an unknown saved task'); }), old = await seedLegacy(f, 'unknown'), service = f.make();
  const request = { ...f.material.scope, taskKey: old.key };
  const unknown = await service.status(f.root, request);
  assert.equal(unknown.status, 'failed'); assert.equal(unknown.recoverable, true); assert.equal(unknown.confirmation, undefined);
  assert.equal((await service.recover(f.root, request)).status, 'complete');
  old.saved.rounds = []; await writeFile(old.path, JSON.stringify(old.saved));
  const empty = await service.status(f.root, request);
  assert.equal(empty.status, 'failed'); assert.equal(empty.confirmation, undefined);
  assert.equal((await service.generate(f.root, { ...request, confirmed: true, confirmationId: 'unused' })).status, 'failed');
  assert.equal(f.calls(), 0);
});

test('an explicit public upgrade cannot bypass an uncertain legacy task but a completed v2 can still be reused', async t => {
  const f = await currentFixture(t, async () => { throw Error('No replacement request'); }, { shared: true });
  let newExists = false, reads = 0, claims = 0;
  const shared = { validateSource: async () => {}, prepareExisting: async (_root, _source, artifact) => artifact.payload.kind === currentRules
    ? { mode: newExists ? 'reuse' : 'publish', taskKey: 'new', requestHash: artifact.payload.requestHash }
    : { mode: 'busy', taskKey: 'unknown-old', status: 'uncertain' },
  read: async (_root, descriptor) => { reads++; assert.equal(descriptor.taskKey, 'new'); return { payload: { schema: currentRules, requestHash: descriptor.requestHash, response: orderResponse() } }; },
  acquire: async () => { claims++; throw Error('Do not acquire'); } };
  const service = f.make({ sharedAnalysis: shared }), request = { ...f.material.scope, rulesVersion: currentRules };
  const blocked = await service.status(f.root, request); assert.equal(blocked.status, 'unavailable'); assert.equal(blocked.blockedBy.status, 'uncertain');
  assert.equal((await service.generate(f.root, { ...request, confirmed: true, confirmationId: 'unused' })).status, 'unavailable');
  newExists = true;
  const reused = await service.status(f.root, request); assert.equal(reused.status, 'complete'); assert.equal(reused.plans[0].speed, 1.3);
  assert.equal(reads, 1); assert.equal(claims, 0); assert.equal(f.calls(), 0);
});

test('concurrent different selectors are checked separately while one lecture still submits only one request', async t => {
  const f = await currentFixture(t, async () => orderResponse()), service = f.make();
  const selected = { ...f.material.scope, rulesVersion: currentRules }, preview = await service.status(f.root, selected);
  const results = await Promise.allSettled([
    service.generate(f.root, { ...selected, confirmed: true, confirmationId: preview.confirmation.id }),
    service.generate(f.root, { ...selected, taskKey: '0'.repeat(64), confirmed: true, confirmationId: preview.confirmation.id }),
  ]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected');
  assert.equal(results[1].reason.status, 409); await service.wait(); assert.equal(f.calls(), 1);
});

// Build frozen v2/v3 keys independently of the new version selector, so a
// migration that silently rewrites its hash cannot make these fixtures pass.
function rangeIdentity(material, version) {
  const prompt = version === 'ai-structure-plans-v2' ? PREVIOUS_COMPOSE_STRUCTURE_PROMPT : COMPOSE_STRUCTURE_PROMPT;
  const inputHash = sharedHash([version, 1.3, inspectAiCompositionInput(material.engineInput).inputHash]);
  const key = sharedHash({ kind: version, prompt, analysis: material.analysisVersion,
    semantic: material.semanticVersion, input: inputHash, visibility: material.visibility });
  const request = createAiStructureRequest(material, { version });
  assert.equal(request.system, prompt);
  return { version, key, request, inputHash };
}
const seedV2 = (f, status = 'complete', complete = true) => seedRange(f, 'ai-structure-plans-v2', status, complete);
async function seedRange(f, version, status = 'complete', complete = true) {
  const old = rangeIdentity(f.material, version), value = { ...rangeResponse([[0, 2, 4]], complete), schema: old.version };
  const digest = text => createHash('sha256').update(text).digest('hex'), rawText = JSON.stringify(value);
  const round = { status, submitted: true, request: old.request,
    receipt: { responseVersion: 'deepseek-text-receipt-v1', provider: 'deepseek', status: 'completed', httpStatus: 200,
      inputSha256: digest(JSON.stringify([old.request.system, old.request.input])), rawText, rawTextSha256: digest(rawText) },
    ...(status === 'complete' ? { response: value, result: validateAiStructureResponse(f.material, value) } : {}) };
  const saved = { version: old.version, key: old.key, sourceId: 's', rounds: [round] }, path = join(f.root, '.film/ai-structure-plans', `${old.key}.json`);
  await mkdir(join(f.root, '.film/ai-structure-plans'), { recursive: true }); await writeFile(path, JSON.stringify(saved));
  return { ...old, path, saved, value };
}

for (const version of ['ai-structure-plans-v2', 'ai-structure-plans-v3']) test(`v5 keeps exact ${version} task, input and plan identities beside v1 without implicit upgrade`, async t => {
  assert.equal(aiStructure.AI_STRUCTURE_VERSION, 'ai-structure-plans-v8');
  const f = await currentFixture(t, async () => orderResponse()), v1 = await seedLegacy(f, 'complete'), v2 = await seedRange(f, version), service = f.make();
  const before = await readFile(v2.path, 'utf8'), initial = await service.status(f.root, f.material.scope);
  assert.equal(initial.version, v2.version); assert.equal(initial.taskKey, v2.key); assert.equal(initial.plans[0].inputHash, v2.inputHash);
  const expectedId = `ai-${sharedHash([v2.version, f.material.engineInput.sourceIdentity, 0, 90000, 1.3, [[0, 13000], [30000, 43000], [60000, 73000]]])}`;
  assert.equal(initial.plans[0].id, expectedId); assert.equal(f.calls(), 0);
  const selected = { ...f.material.scope, rulesVersion: currentRules }, preview = await service.status(f.root, selected);
  assert.equal(preview.status, 'idle'); assert.notEqual(preview.taskKey, v2.key); assert.equal(preview.confirmation.rulesVersion, currentRules);
  await service.generate(f.root, { ...selected, confirmed: true, confirmationId: preview.confirmation.id }); await service.wait();
  const done = await service.status(f.root, f.material.scope);
  assert.equal(done.version, currentRules); assert.notEqual(done.plans[0].id, expectedId);
  assert.deepEqual(new Set(done.savedVersions.map(item => item.version)), new Set([oldRules, v2.version, currentRules]));
  for (const old of [v1, v2]) assert.equal((await f.make().status(f.root, { ...f.material.scope, taskKey: old.key })).version, old.version);
  assert.equal(await readFile(v2.path, 'utf8'), before); assert.equal(f.calls(), 1);
});

for (const version of ['ai-structure-plans-v2', 'ai-structure-plans-v3']) test(`${version} receipt recovery keeps its frozen prompt and blocks v5 until recovered`, async t => {
  const f = await currentFixture(t, async () => { throw Error('Recovery must not call the provider'); }), old = await seedRange(f, version, 'failed'), service = f.make();
  const selected = { ...f.material.scope, rulesVersion: currentRules }, blocked = await service.status(f.root, selected);
  assert.equal(blocked.status, 'unavailable'); assert.equal(blocked.blockedBy.version, old.version);
  const recovered = await service.recover(f.root, { ...f.material.scope, taskKey: old.key });
  assert.equal(recovered.status, 'complete'); assert.equal(recovered.version, old.version); assert.equal(recovered.plans[0].inputHash, old.inputHash);
  assert.deepEqual(JSON.parse(await readFile(old.path, 'utf8')).rounds[0].request, old.request);
  assert.equal((await service.status(f.root, selected)).status, 'idle'); assert.equal(f.calls(), 0);
});

test('v2 continuation sends its original rules; v2 cannot start a first request after the upgrade', async t => {
  const f = await fixture(t, async request => {
    assert.equal(request.system, PREVIOUS_COMPOSE_STRUCTURE_PROMPT);
    assert.equal(JSON.parse(request.input).previous.length, 1);
    return { ...rangeResponse([[1, 3, 5]]), schema: 'ai-structure-plans-v2' };
  }), service = f.make();
  const absent = await service.status(f.root, { ...f.material.scope, rulesVersion: 'ai-structure-plans-v2' });
  assert.equal(absent.status, 'unavailable'); assert.equal(absent.confirmation, undefined);
  const old = await seedV2(f, 'complete', false), selected = { ...f.material.scope, taskKey: old.key };
  const preview = await service.status(f.root, selected); assert.equal(preview.canContinue, true);
  await service.generate(f.root, { ...selected, continue: true, confirmed: true, confirmationId: preview.confirmation.id }); await service.wait();
  const done = await service.status(f.root, selected); assert.equal(done.plans.length, 2); assert.equal(done.version, old.version); assert.equal(f.calls(), 1);
});

for (const version of ['ai-structure-plans-v2', 'ai-structure-plans-v3']) test(`a colleague reuses public ${version} by its original request hash without v5 or a model call`, async t => {
  const f = await fixture(t, async () => { throw Error('No new request for a saved historical version'); }, { shared: true }), old = rangeIdentity(f.material, version);
  const probes = [];
  const shared = { validateSource: async () => {}, prepareExisting: async (_root, _source, artifact) => {
    probes.push(artifact.payload.kind);
    if (['ai-structure-plans-v4', 'ai-structure-plans-v5', 'ai-structure-plans-v6', 'ai-structure-plans-v7'].includes(artifact.payload.kind)) return { mode: 'publish', taskKey: 'no-saved-v4' };
    if (artifact.payload.kind === 'ai-structure-plans-v3' && old.version === 'ai-structure-plans-v2') return { mode: 'publish', taskKey: 'no-saved-v3' };
    assert.equal(artifact.payload.kind, old.version); assert.equal(artifact.payload.key, old.key);
    assert.equal(artifact.payload.requestHash, sharedHash(old.request)); return { mode: 'reuse', taskKey: 'saved-v2-public' };
  }, read: async () => ({ payload: { schema: old.version, requestHash: sharedHash(old.request), response: { ...rangeResponse(), schema: old.version } } }),
  acquire: async () => { throw Error('Do not claim'); } };
  const done = await f.make({ sharedAnalysis: shared }).status(f.root, f.material.scope);
  assert.equal(done.status, 'complete'); assert.equal(done.taskKey, old.key); assert.equal(done.plans[0].version, old.version); assert.equal(f.calls(), 0);
  assert.deepEqual(probes, version === 'ai-structure-plans-v2' ? ['ai-structure-plans-v7', 'ai-structure-plans-v6', 'ai-structure-plans-v5', 'ai-structure-plans-v4', 'ai-structure-plans-v3', version] : ['ai-structure-plans-v7', 'ai-structure-plans-v6', 'ai-structure-plans-v5', 'ai-structure-plans-v4', version]);
});

for (const version of ['ai-structure-plans-v2', 'ai-structure-plans-v3']) test(`pending ${version} publication retains its original response and request hash after v5 upgrade`, async t => {
  const f = await fixture(t, async () => { throw Error('Publication does not call models'); }, { shared: true }), old = await seedRange(f, version, 'publish-pending');
  Object.assign(old.saved.rounds[0], { response: old.value, descriptor: { mode: 'publish-pending', taskKey: 'old-public-v2' }, attemptId: 'old-attempt-v2' });
  await writeFile(old.path, JSON.stringify(old.saved));
  const sent = [], service = f.make({ sharedAnalysis: { complete: async (_root, descriptor, attemptId, payload) => sent.push({ descriptor, attemptId, payload }) } });
  assert.equal((await service.publish(f.root, { sourceId: 's', taskKey: old.key, confirmed: true })).status, 'complete');
  assert.equal(sent.length, 1); assert.equal(sent[0].attemptId, 'old-attempt-v2');
  assert.equal(sent[0].payload.schema, old.version); assert.equal(sent[0].payload.requestHash, sharedHash(old.request));
  assert.deepEqual(sent[0].payload.response, old.value); assert.equal(f.calls(), 0);
});

for (const version of ['ai-structure-plans-v2', 'ai-structure-plans-v3']) test(`a ${version} response cannot become a v5 result through acceptance or recovery`, async t => {
  const f = await fixture(t, async () => ({ ...rangeResponse(), schema: version })), service = f.make();
  await f.confirm(service); await service.wait();
  const failed = await service.status(f.root, f.material.scope);
  assert.equal(failed.status, 'failed'); assert.equal(failed.plans.length, 0);
  assert.equal((await service.recover(f.root, { ...f.material.scope, taskKey: failed.taskKey })).status, 'failed');
  assert.equal(f.calls(), 1);
});
