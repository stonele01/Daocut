import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createAiStructureRequest, validateAiStructureResponse, AI_STRUCTURE_VERSION } from './ai-structure.mjs';
import { aiStructurePrompt } from './ai-structure.mjs';
import { flexibleInput, getAiPricedCoverage, inspectAiPricedInput } from './ai-structure-priced.mjs';
import { createAiStructurePlans } from './ai-structure-plans.mjs';
import { sharedHash } from './shared-analysis.mjs';

function fixture() {
  const rows = [
    ['今天介绍这款防脱洗发水', ['intro']],
    ['洗完头发蓬松，适合头皮出油的人', ['core']],
    ['今天69元一瓶，两瓶138', ['price']],
    ['今天六十九一瓶的，手速快只要三十九，一瓶39', ['price']],
    ['两瓶39加39是78，今天两瓶改成59，一瓶39', ['price']],
    ['想要的朋友现在就拍', ['purchase']],
    ['洗完梳起来顺滑，不容易打结', ['core']],
    ['清洗时泡沫细密，容易冲洗', ['core']],
    ['草本成分，味道清新', ['core']],
    ['需要的朋友点一号链接拍', ['purchase']],
  ];
  const scope = { sourceId: 's', productId: 'p', intervalId: 'i', startMs: 0, endMs: 100000 };
  const cues = rows.map(([text], index) => ({ text, startMs: index * 10000, endMs: (index + 1) * 10000 }));
  const candidates = rows.map(([, roles], index) => ({ ...cues[index], ...scope, startMs: cues[index].startMs, endMs: cues[index].endMs,
    id: `c${index}`, cueRange: [120 + index, 120 + index], tags: [], details: { composition: {
      contract: 'complete-speech-v1', status: 'confirmed', roles, requires: [], excludes: [], conditions: {},
      ...(roles.includes('price') ? { price: { kind: 'current', evidence: [0] } } : {}),
      openingPolicy: 'curated-openings-v1', ...(index === 0 ? { opening: { group: '防脱产品介绍', followup: '说明适合谁及价格' } } : {}),
    } } }));
  return { source: { id: 's', assetPath: 'assets/test.mp4' }, scope, context: scope, visibility: 'local',
    engineInput: { scope, sourceIdentity: 'fixture', cues, cueIndices: cues.map((_, index) => 120 + index), candidates }, issues: [] };
}
const prices = [
  { id: 'c2', kind: 'superseded', evidence: [122, 123, 124], replacedBy: ['c3', 'c4'] },
  { id: 'c3', kind: 'current', evidence: [123] },
  { id: 'c4', kind: 'current', evidence: [124] },
];
const validate = (input, plans, extra = {}, options) => validateAiStructureResponse(input, { schema: AI_STRUCTURE_VERSION, prices, plans, ...extra }, options);

test('missing price retry sends precise feedback once, preserves raw history, and another computer imports it without a call', async t => {
  const base = resolve(import.meta.dirname, '../../../../.tmp/priced-retry'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'case-'));
  t.after(async () => { assert.ok(resolve(root).startsWith(base + sep)); await rm(root, { recursive: true, force: true }); });
  const input = fixture(); input.visibility = 'shared';
  const results = new Map(), descriptors = new Map(), calls = [];
  const shared = {
    validateSource: async () => {},
    prepareExisting: async (_root, _source, artifact) => {
      const taskKey = sharedHash(artifact.payload), descriptor = { taskKey, dataHash: taskKey, catalog: { action: artifact.action, scope: artifact.scope }, mode: results.has(taskKey) ? 'reuse' : 'publish' };
      descriptors.set(taskKey, descriptor); return descriptor;
    },
    acquire: async () => ({ attemptId: 'test' }), fail: async () => {},
    complete: async (_root, descriptor, _attempt, payload) => results.set(descriptor.taskKey, structuredClone(payload)),
    history: async () => ({ results: [...results.keys()].map(taskKey => ({ taskKey, catalog: descriptors.get(taskKey).catalog, result: { sha256: taskKey } })) }),
    historicalArtifact: async (_root, _source, taskKey) => ({ descriptor: descriptors.get(taskKey), result: { sha256: taskKey }, snapshot: { dataHash: taskKey, payload: results.get(taskKey) } }),
    read: async (_root, descriptor) => ({ payload: results.get(descriptor.taskKey) }),
  };
  const modelClient = async args => {
    calls.push({ system: args.system, body: JSON.parse(args.input) });
    return { schema: AI_STRUCTURE_VERSION, prices: calls.length === 1 ? prices.slice(1) : prices, plans: [['c0', 'c1', 'c4', 'c5']] };
  };
  const options = { readInput: async () => input, sharedAnalysis: shared, modelIdentity: 'test', modelClient };
  const service = createAiStructurePlans(options), selection = { ...input.scope, rulesVersion: AI_STRUCTURE_VERSION };
  const initial = await service.status(root, selection);
  await service.generate(root, { ...selection, confirmed: true, confirmationId: initial.confirmation.id }); await service.wait();
  const failed = await service.status(root, selection); assert.equal(failed.status, 'failed'); assert.equal(failed.plans.length, 0);
  const file = join(root, '.film/ai-structure-plans', failed.taskKey + '.json'), before = JSON.parse(await readFile(file, 'utf8'));
  const request = { ...selection, taskKey: failed.taskKey }, preview = await service.retry(root, request);
  assert.equal(calls.length, 1); assert.equal(preview.confirmation.requestCount, 1);
  const submitted = { ...request, confirmed: true, confirmationId: preview.confirmation.id };
  await Promise.all([service.retry(root, submitted), service.retry(root, submitted)]); await service.wait();
  assert.equal(calls.length, 2); assert.equal(calls[1].system, calls[0].system);
  const feedback = calls[1].body.feedback.at(-1); assert.equal(feedback.code, 'AI_PRICE_AUDIT_INCOMPLETE'); assert.deepEqual(feedback.missingIds, ['c2']);
  const { feedback: _feedback, ...retryBody } = calls[1].body, { feedback: _oldFeedback, ...oldBody } = calls[0].body;
  assert.deepEqual(retryBody, oldBody, 'only validation feedback changes; material, targets and prior plans remain identical');
  const after = JSON.parse(await readFile(file, 'utf8')); assert.deepEqual(after.rounds.slice(0, 1), before.rounds);
  const done = await service.status(root, request); assert.equal(done.complete, true); assert.equal(done.plans.length, 1);
  const readerRoot = join(root, 'other-computer'), reader = createAiStructurePlans({ ...options, modelClient: async () => { throw Error('must reuse'); } });
  const imported = await reader.status(readerRoot, selection);
  assert.equal(imported.complete, true); assert.deepEqual(imported.plans.map(p => p.id), done.plans.map(p => p.id));
  assert.equal(calls.length, 2);
});

test('old current labels do not override the contextual price review, and a price contrast must end in its corrected quote', () => {
  const input = fixture();
  assert.equal(validate(input, [['c0', 'c1', 'c2', 'c5']]).plans.length, 0);
  assert.equal(validate(input, [['c0', 'c1', 'c4', 'c5']]).plans.length, 1);
  assert.equal(validate(input, [['c0', 'c1', 'c2', 'c4', 'c5']]).plans.length, 1);
  assert.equal(validate(input, [['c0', 'c1', 'c4', 'c2', 'c5']]).plans.length, 0);
  assert.throws(() => validate(input, [], { prices: undefined }), /报价核对/);
  assert.throws(() => validate(input, [], { prices: prices.slice(1) }), /全部价格/);
  assert.throws(() => validate(input, [], { prices: prices.map(p => p.id === 'c2' ? { ...p, replacedBy: ['c2'] } : p) }), /替代报价/);
  assert.throws(() => validate(input, [], { prices: prices.map(p => ({ ...p, evidence: [999] })) }), /真实/);
  assert.throws(() => validate(input, [], { prices: prices.map(p => p.id === 'c2' ? { ...p, evidence: [122] } : p) }), /字幕依据/);
  const request = JSON.parse(createAiStructureRequest(input).input);
  assert.deepEqual(request.transcript[4], [124, input.engineInput.cues[4].text]);
  assert.equal(request.rules.maxVariantsPerOpening, 3);
  assert.deepEqual(request.units.find(unit => unit.id === 'c2').cueRange, [122, 122]);
});

test('different currently valid specifications are not automatically replaced by a later or lower number', () => {
  const input = fixture();
  input.engineInput.candidates[2].details.composition.conditions = { 规格: '大瓶' };
  input.engineInput.candidates[3].details.composition.conditions = { 规格: '小瓶' };
  const separate = prices.map(p => p.id === 'c2' ? { id: 'c2', kind: 'current', evidence: [122] } : p);
  assert.equal(validate(input, [['c0', 'c1', 'c2', 'c5']], { prices: separate }).plans.length, 1);
  assert.equal(validate(input, [['c0', 'c1', 'c2', 'c3', 'c5']], { prices: separate }).plans.length, 0, 'conflicting specifications cannot become one offer');
});

test('a misclassified reference quote blocks dependent plans without discarding independent valid plans', () => {
  const input = fixture();
  input.engineInput.candidates[3].details.composition.price.kind = 'reference';
  const response = { schema: AI_STRUCTURE_VERSION, prices: structuredClone(prices), plans: [
    ['c0', 'c1', 'c4', 'c5'],
    ['c0', 'c1', 'c3', 'c4', 'c5'],
    ['c0', 'c1', 'c2', 'c4', 'c5'],
  ] };
  const original = structuredClone(response);
  const result = validateAiStructureResponse(input, response);
  assert.deepEqual(result.sequences, [['c0', 'c1', 'c4', 'c5']]);
  assert.equal(result.prices.find(p => p.id === 'c3').kind, 'uncertain');
  assert.equal(result.prices.find(p => p.id === 'c2').kind, 'uncertain');
  assert.ok(result.issues.some(i => i.code === 'AI_PRICE_ROLE_UNCONFIRMED'));
  assert.deepEqual(response, original, 'the saved model response remains untouched');
  assert.throws(() => validateAiStructureResponse(input, { ...response, plans: response.plans.slice(1) }), /没有可独立保留/,
    'an entirely invalid batch remains failed so the workflow cannot turn it into an automatic coverage retry');
});

test('a verified saved response is rechecked without changing the original result or calling the model', async t => {
  const base = resolve('../../.tmp/priced-recheck'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'case-'));
  t.after(async () => { assert.ok(resolve(root).startsWith(base + sep)); await rm(root, { recursive: true, force: true }); });
  const input = fixture(); input.analysisVersion = 'original-analysis'; input.semanticVersion = 'original-semantics';
  input.engineInput.candidates[0].details.composition.conditions = { coupon: true };
  input.engineInput.candidates[1].details.composition.conditions = { coupon: '20元券' };
  const request = createAiStructureRequest(input, { version: AI_STRUCTURE_VERSION });
  const response = { schema: AI_STRUCTURE_VERSION, prices, plans: [['c0', 'c1', 'c4', 'c5']] };
  const checked = validateAiStructureResponse(input, response, { expectedVersion: AI_STRUCTURE_VERSION });
  assert.equal(checked.plans.length, 1);
  const rawText = JSON.stringify(response), digest = value => createHash('sha256').update(value).digest('hex');
  const receipt = { responseVersion: 'deepseek-text-receipt-v1', provider: 'deepseek', status: 'completed', httpStatus: 200,
    rawText, rawTextSha256: digest(rawText), inputSha256: digest(JSON.stringify([request.system, request.input])) };
  const original = { ...checked, plans: [], sequences: [], issues: [{ code: 'AI_ORDER_CONDITIONS', message: '旧校验误判' }] };
  const key = sharedHash({ kind: AI_STRUCTURE_VERSION, prompt: aiStructurePrompt(AI_STRUCTURE_VERSION), analysis: input.analysisVersion,
    semantic: input.semanticVersion, input: inspectAiPricedInput(flexibleInput(input).engineInput).inputHash, visibility: input.visibility });
  const dir = join(root, '.film/ai-structure-plans'); await mkdir(dir, { recursive: true });
  const file = join(dir, `${key}.json`), bytes = JSON.stringify({ version: AI_STRUCTURE_VERSION, key, sourceId: input.source.id,
    rounds: [{ status: 'complete', submitted: true, request, response, receipt, result: original }] });
  await writeFile(file, bytes);
  let calls = 0;
  const service = createAiStructurePlans({ readInput: async () => input, modelClient: async () => { calls++; throw Error('must not call model'); } });
  const result = await service.status(root, input.scope);
  assert.equal(result.plans.length, 1);
  assert.equal(calls, 0);
  assert.equal(await readFile(file, 'utf8'), bytes);
});

test('three substantive routes per opening across rounds, no extra route for a different closing, and shortages are allowed', () => {
  const input = fixture(), routes = [1, 6, 7, 8].map(core => ['c0', `c${core}`, 'c4', 'c5']);
  const first = validate(input, [...routes, ['c0', 'c1', 'c4', 'c9']]);
  assert.equal(first.plans.length, 3);
  assert.ok(first.issues.some(issue => issue.code === 'AI_VARIANT_NOT_DISTINCT'));
  assert.ok(first.issues.some(issue => issue.code === 'AI_OPENING_VARIANT_LIMIT'));
  assert.equal(validate(input, [routes[3]], {}, { previous: first.sequences }).plans.length, 0);
  const short = validate(input, [routes[0]]);
  assert.equal(short.plans.length, 1);
  assert.equal(short.modelComplete, true, 'one feasible route is not a failed round');
  assert.equal(getAiPricedCoverage(input, first.sequences).perOpening[0].distinctCount, 3);
  assert.equal(validate(input, [['c0', 'c4', 'c5']]).plans.length, 0, 'no selling point and too short');
});

test('fallback closing accepts verified unit price, benefit, or price-free core', () => {
  const input = fixture(), engine = input.engineInput;
  engine.candidates = engine.candidates.filter(c => ['c0', 'c1', 'c3', 'c6'].includes(c.id));
  const price = engine.candidates.find(c => c.id === 'c3');
  price.text = engine.cues[3].text = '十九块九，到手二十四包，一包卫生纸八毛钱';
  delete price.details.composition.price;
  const quote = [{ id: 'c3', kind: 'current', evidence: [123] }];
  const plan = ['c0', 'c1', 'c6', 'c3'];
  assert.ok(inspectAiPricedInput(flexibleInput(input).engineInput).ready);
  assert.equal(validate(input, [plan], { prices: quote }).plans.length, 1);
  assert.equal(validate(input, [['c0','c1','c3','c6']], { prices: quote }).plans.length, 0);
  price.tags = ['价格机制'];
  price.details.composition.roles = ['trust'];
  const body = JSON.parse(createAiStructureRequest(input).input);
  assert.equal(body.rules.purchaseLast, false);
  assert.ok(body.units.find(unit => unit.id === 'c3').roles.includes('price'));
  assert.equal(validate(input, [plan], { prices: quote }).plans.length, 1);
  assert.throws(() => validate(input, [plan], { prices: [] }), /全部价格/);
  price.tags = [];
  price.text = engine.cues[3].text = '下单还额外赠送一个收纳袋';
  price.details.composition.roles = ['offer'];
  assert.equal(validate(input, [plan], { prices: [] }).plans.length, 1);
  price.text = engine.cues[3].text = '有多个老顾客回购';
  price.details.composition.roles = ['trust'];
  assert.equal(validate(input, [['c0','c1','c3','c6']], { prices: [] }).plans.length, 1);
  assert.equal(validateAiStructureResponse(input, {schema:'ai-structure-plans-v8', plans:[plan], prices:[]}).plans.length, 0);
});

test('v9 references exact transcript text, preserves differing wording, and v8 retains its original request', () => {
  const input = fixture();
  const legacy = JSON.parse(createAiStructureRequest(input, {version: 'ai-structure-plans-v8'}).input);
  assert.ok(legacy.units.every(unit => typeof unit.text === 'string'));
  const modern = JSON.parse(createAiStructureRequest(input).input);
  assert.ok(modern.units.length > 0 && modern.units.every(unit => !Object.hasOwn(unit, 'text')));
  assert.deepEqual(modern.transcript, legacy.transcript);
  const changed = input.engineInput.candidates[0];
  const first = input.engineInput.cues[0];
  const split = Math.floor((first.startMs + first.endMs) / 2);
  input.engineInput.cues.splice(0, 1, { ...first, text: 'Brand', endMs: split }, { ...first, text: 'Name', startMs: split });
  input.engineInput.cueIndices.unshift(119);
  changed.cueRange = [119, 120];
  changed.text = 'Brand Name';
  const revised = JSON.parse(createAiStructureRequest(input).input);
  assert.equal(revised.units.find(unit => unit.id === changed.id).text, changed.text);
});

test('v9 applies the input limit to the compact request including the full transcript', () => {
  const input = fixture(), engine = input.engineInput, first = engine.candidates[0];
  first.text = engine.cues[0].text = '衣'.repeat(11000);
  for (let i = 0; i < 6; i++) engine.candidates.push({ ...first, id: 'overlap-' + i });
  assert.throws(() => createAiStructureRequest(input, { version: 'ai-structure-plans-v8' }), { code: 'AI_STRUCTURE_INPUT_TOO_LARGE' });
  assert.ok(JSON.parse(createAiStructureRequest(input).input).units.length >= 6);
  first.text = engine.cues[0].text = '衣'.repeat(45000);
  assert.throws(() => createAiStructureRequest(input), { code: 'AI_STRUCTURE_INPUT_TOO_LARGE' });
});
