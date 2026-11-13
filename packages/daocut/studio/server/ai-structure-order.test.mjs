import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AI_STRUCTURE_ORDER_VERSION, AI_STRUCTURE_ORDER_PROMPT, inspectAiOrderInput, createAiOrderRequest, validateAiStructureOrder, getAiOrderCoverage } from './ai-structure-order.mjs';

function fixture() {
  const scope = { sourceId: 's', productId: 'p', intervalId: 'i', startMs: 0, endMs: 100000 };
  const data = [
    ['pain', 0, 12000, '洗完头一梳就打结，早上赶时间很麻烦。', ['pain']],
    ['core-a', 13000, 28000, '这个泵头可以单手按，手湿也不用拧盖。', ['core']],
    ['core-b', 29000, 42000, '瓶身透明，剩余多少一眼就看清。', ['core']],
    ['offer', 43000, 52000, '同一瓶平时89，今天体验价59。', ['offer']],
    ['close', 53000, 66000, '今天需要的点购买链接，核对规格后付款。', ['purchase']],
  ];
  const cues = data.map(([, startMs, endMs, text]) => ({ startMs, endMs, text }));
  const candidates = data.map(([id, startMs, endMs, text, roles], index) => ({ id, ...scope, startMs, endMs, text, cueRange: [100 + index, 100 + index], tags: [], version: 'fixture',
    details: { review: ['仅依据 ASR；画面、声音和句级边界待核实'], composition: { contract: 'complete-speech-v1', status: 'confirmed', roles, requires: [], excludes: [], conditions: {} } } }));
  return { scope, context: scope, source: { id: 's', assetPath: 'assets/synthetic.mp4' }, visibility: 'local',
    engineInput: { scope, sourceIdentity: 'synthetic-sha', cues, cueIndices: [100, 101, 102, 103, 104], candidates } };
}
const response = (plans = [['pain', 'core-a', 'close']]) => ({ schema: AI_STRUCTURE_ORDER_VERSION, plans });
const review = (f, id) => f.engineInput.candidates.find(candidate => candidate.id === id).details.composition;
function rejected(f, plans, code) {
  const result = validateAiStructureOrder(f, response(plans));
  assert.equal(result.plans.length, 0);
  assert.equal(result.sequences.length, 0);
  assert.ok(result.issues.some(issue => issue.code === code), JSON.stringify(result.issues));
  assert.equal(getAiOrderCoverage(f, plans).covered, 0);
  return result;
}

test('v4 prompt and review copy agree on one accepted plan per requested opening and strict ID-only output', async () => {
  const copy = await readFile(new URL('../../../../docs/prompts-review-20261111/03-compose-structure-v4.txt', import.meta.url), 'utf8');
  assert.equal(AI_STRUCTURE_ORDER_PROMPT, copy.replace(/\r\n/g, '\n').trim());
  assert.match(copy, /每个编号，至少配出一条/);
  assert.match(copy, /不要求穷尽全部排列/);
  assert.match(copy, /不要输出 complete/);
  assert.match(copy, /拟改89理解为现在也卖89/);
});

test('inspection tracks every confirmed independent non-purchase opening, including cores and ordinary offers', () => {
  const f = fixture(), result = inspectAiOrderInput(f.engineInput);
  assert.equal(result.ready, true); assert.equal(result.eligibleCount, 5);
  assert.deepEqual(result.openingIds, ['pain', 'core-a', 'core-b', 'offer']);
  assert.equal(result.inputHash.length, 64);
  review(f, 'pain').requires = ['offer'];
  review(f, 'core-b').status = 'pending';
  f.engineInput.candidates[2].details.review.push('这一句指代尚不明确');
  const coverage = getAiOrderCoverage(f, []);
  assert.deepEqual(coverage.openingIds, ['core-a', 'offer']);
  assert.equal(coverage.total, 2); assert.equal(coverage.covered, 0);
  assert.match(coverage.excluded.find(item => item.id === 'pain').reason, /前置话术.*offer/);
  assert.match(coverage.excluded.find(item => item.id === 'core-b').reason, /指代尚不明确/);
  assert.match(coverage.excluded.find(item => item.id === 'close').reason, /购买逼单/);
});

test('request sends compact complete units, explicit target IDs and feedback without transcript or technical media payload', () => {
  const f = fixture(), before = structuredClone(f);
  f.mediaReview = { segments: [{ audio: { peakDb: 123 }, debug: 'technical-data-must-not-leak' }] };
  f.visualReview = { status: 'complete', issues: [], entries: [{ startMs: 0, endMs: 12000, productMatch: 'match', display: 'shown', observation: '桌面可见该商品', evidenceTimesMs: [1000], issues: [] }] };
  const request = createAiOrderRequest(f, { openingIds: ['offer'], previous: [['pain', 'core-a', 'close']], feedback: [{ openingId: 'offer', code: 'AI_ORDER_DURATION', message: '此前完整时长偏短' }] });
  const body = JSON.parse(request.input);
  assert.equal(request.system, AI_STRUCTURE_ORDER_PROMPT);
  assert.deepEqual(body.openingIds, ['offer']);
  assert.equal(body.units.length, 5);
  assert.deepEqual(body.units[0], { id: 'pain', text: before.engineInput.candidates[0].text, roles: ['pain'], durationMs: 12000, requires: [], excludes: [], conditions: {},
    visual: [{ productMatch: 'match', display: 'shown', observation: '桌面可见该商品', issues: [] }] });
  assert.deepEqual(body.previous, [['pain', 'core-a', 'close']]);
  assert.equal(body.feedback[0].openingId, 'offer');
  for (const key of ['transcript', 'cues', 'mediaReview']) assert.equal(Object.hasOwn(body, key), false);
  assert.ok(!request.input.includes('technical-data-must-not-leak'));
  assert.ok(!request.input.includes('startMs')); assert.ok(!request.input.includes('cueRange'));
  assert.deepEqual(f.engineInput, before.engineInput);
  assert.throws(() => createAiOrderRequest(f, { openingIds: ['close'] }), { code: 'AI_STRUCTURE_INVALID_RESPONSE' });
});

test('shared request does not leak local visual supplements and stale evidence is identified', () => {
  const f = fixture();
  f.visualReview = { status: 'complete', issues: ['private-note'], entries: [] };
  f.visibility = 'shared'; f.compositionEvidence = {};
  assert.ok(!createAiOrderRequest(f).input.includes('private-note'));
  f.visibility = 'local'; f.visualReviewStale = true;
  assert.equal(JSON.parse(createAiOrderRequest(f).input).visualReview.status, 'stale');
});

test('whole-unit order restores exact source text and times at 1.3 without rewriting saved input', () => {
  const f = fixture(), before = structuredClone(f);
  const result = validateAiStructureOrder(f, response());
  assert.equal(result.plans.length, 1);
  const plan = result.plans[0];
  assert.equal(plan.version, AI_STRUCTURE_ORDER_VERSION);
  assert.equal(plan.sourceDurationMs, 40000); assert.equal(plan.durationMs, 40000 / 1.3); assert.equal(plan.speed, 1.3);
  assert.deepEqual(plan.clips.map(clip => [clip.candidateId, clip.startMs, clip.endMs, clip.cueRange, clip.text]), [0, 1, 4].map(index => {
    const c = f.engineInput.candidates[index]; return [c.id, c.startMs, c.endMs, c.cueRange, c.text];
  }));
  assert.ok(plan.clips.every(clip => clip.assetPath === 'assets/synthetic.mp4' && clip.speed === 1.3));
  assert.deepEqual(plan.clips[0].roles, ['hook', 'pain']);
  assert.deepEqual(result.sequences, [['pain', 'core-a', 'close']]);
  assert.equal(result.modelComplete, false); assert.equal(result.allValidCombinationsEnumerated, false);
  assert.deepEqual(f, before);
});

test('coverage counts only first IDs of accepted rows across rounds and allows multiple plans per opening', () => {
  const f = fixture();
  const rows = [['pain', 'core-a', 'close'], ['pain', 'core-b', 'offer', 'close'], ['core-a', 'pain', 'close'], ['core-b', 'core-a', 'close'], ['offer', 'pain', 'core-a', 'close']];
  const result = validateAiStructureOrder(f, response(rows));
  assert.equal(result.plans.length, 5); assert.equal(result.modelComplete, true);
  const first = getAiOrderCoverage(f, rows.slice(0, 2));
  assert.equal(first.covered, 1); assert.equal(first.total, 4);
  assert.deepEqual(first.remainingIds, ['core-a', 'core-b', 'offer']);
  const all = getAiOrderCoverage(f, [...rows, rows[0]]);
  assert.equal(all.covered, 4); assert.deepEqual(all.remainingIds, []);
  assert.equal(validateAiStructureOrder(f, response([])).modelComplete, false);
  assert.equal(getAiOrderCoverage(f, []).covered, 0);
});

test('duplicate rows deduplicate actual playback while different body orders remain separate', () => {
  const f = fixture(), rows = [['pain', 'core-a', 'close'], ['core-a', 'pain', 'close']];
  const result = validateAiStructureOrder(f, response([...rows, rows[0]]));
  assert.equal(result.plans.length, 2); assert.deepEqual(result.sequences, rows);
  assert.notEqual(result.plans[0].id, result.plans[1].id);
});

test('format rejects rewritten text, timestamps, tags, numbers and model completion declarations', () => {
  for (const value of [
    { ...response(), complete: true }, { ...response(), issues: [] }, { ...response(), title: '新标题' },
    response([[{ id: 'pain', startMs: 0 }]]), response([[{ id: 'pain', tags: ['痛点'] }]]), response([[0, 1, 4]]), response([[]]),
    { schema: 'ai-structure-plans-v3', plans: [['pain', 'core-a', 'close']] },
  ]) assert.throws(() => validateAiStructureOrder(fixture(), value), { code: 'AI_STRUCTURE_INVALID_RESPONSE' });
});

test('unknown, repeated and unresolved units do not count as coverage even with a valid first ID', () => {
  rejected(fixture(), [['pain', 'unknown', 'close']], 'AI_ORDER_UNIT');
  rejected(fixture(), [['pain', 'core-a', 'pain', 'close']], 'AI_ORDER_REPEAT');
  const f = fixture(); review(f, 'core-a').status = 'pending';
  rejected(f, [['pain', 'core-a', 'close']], 'AI_ORDER_UNIT');
  const duplicate = fixture(); duplicate.engineInput.candidates.push(structuredClone(duplicate.engineInput.candidates[0]));
  rejected(duplicate, [['pain', 'core-a', 'close']], 'AI_ORDER_UNIT');
});

test('one rejected opening does not discard other accepted openings or count an empty result as coverage', () => {
  const f = fixture();
  const rows = [['pain', 'unknown', 'close'], ['core-a', 'pain', 'close'], ['offer', 'close']];
  const checked = validateAiStructureOrder(f, response(rows));
  assert.deepEqual(checked.sequences, [['core-a', 'pain', 'close']]);
  const coverage = getAiOrderCoverage(f, rows);
  assert.equal(coverage.covered, 1); assert.deepEqual(coverage.remainingIds, ['pain', 'core-b', 'offer']);
  assert.equal(checked.modelComplete, false);
});

test('missing cue provenance, changed source text and another lecture are rejected without guessed times', () => {
  for (const change of [f => { delete f.engineInput.candidates[1].cueRange; }, f => { f.engineInput.cues.splice(1, 1); f.engineInput.cueIndices.splice(1, 1); },
    f => { f.engineInput.candidates[1].text = '改写了原话'; }, f => { f.engineInput.candidates[1].intervalId = 'return-visit'; }]) {
    const f = fixture(); change(f); rejected(f, [['pain', 'core-a', 'close']], 'AI_ORDER_UNIT');
  }
  const gap = fixture();
  gap.engineInput.candidates[1].cueRange = [100, 102];
  gap.engineInput.candidates[1].startMs = 0; gap.engineInput.candidates[1].endMs = 42000;
  gap.engineInput.cues.splice(1, 1); gap.engineInput.cueIndices.splice(1, 1);
  gap.engineInput.candidates[1].text = gap.engineInput.cues.slice(0, 2).map(c => c.text).join('');
  assert.ok(inspectAiOrderInput(gap.engineInput).issues.some(issue => issue.code === 'AI_ORDER_CUE_RANGE'));
});

test('a core opening counts as a core, one or two are required, and purchase stays last', () => {
  assert.equal(validateAiStructureOrder(fixture(), response([['core-a', 'core-b', 'close']])).plans.length, 1);
  rejected(fixture(), [['close', 'pain', 'core-a']], 'AI_ORDER_OPENING');
  rejected(fixture(), [['pain', 'close', 'core-a']], 'AI_ORDER_STRUCTURE');
  rejected(fixture(), [['pain', 'offer', 'close']], 'AI_ORDER_STRUCTURE');
  rejected(fixture(), [['pain', 'core-a', 'offer']], 'AI_ORDER_STRUCTURE');
  const f = fixture(); review(f, 'offer').roles = ['core'];
  rejected(f, [['core-a', 'core-b', 'offer', 'close']], 'AI_ORDER_STRUCTURE');
});

test('known dependencies, exclusions and source overlap remain hard constraints', () => {
  const f = fixture(); review(f, 'pain').requires = ['offer'];
  rejected(f, [['pain', 'core-a', 'close']], 'AI_ORDER_OPENING');
  assert.equal(validateAiStructureOrder(f, response([['offer', 'pain', 'core-a', 'close']])).plans.length, 1);
  rejected(f, [['core-a', 'pain', 'close']], 'AI_ORDER_CONTEXT');
  const conflict = fixture(); review(conflict, 'core-a').excludes = ['close'];
  rejected(conflict, [['pain', 'core-a', 'close']], 'AI_ORDER_EXCLUDED');
  const overlap = fixture(), alias = structuredClone(overlap.engineInput.candidates[1]); alias.id = 'alias'; overlap.engineInput.candidates.push(alias);
  rejected(overlap, [['pain', 'core-a', 'alias', 'close']], 'AI_ORDER_OVERLAP');
});

test('price role keys remain distinct while ambiguous legacy price and incompatible quantities are reported concretely', () => {
  const f = fixture(); review(f, 'pain').conditions = { currentPrice: 59, referencePrice: 89 }; review(f, 'close').conditions = { futurePrice: 89 };
  assert.equal(validateAiStructureOrder(f, response()).plans.length, 1);
  review(f, 'pain').conditions = { price: 59 }; review(f, 'close').conditions = { price: 89 };
  const price = rejected(f, [['pain', 'core-a', 'close']], 'AI_ORDER_PRICE_METADATA');
  assert.match(price.issues[0].message, /59.*89.*现价、参考价或拟改价/);
  assert.equal(review(f, 'close').conditions.price, 89, 'no rewriting saved metadata');
  review(f, 'pain').conditions = { quantity: 1 }; review(f, 'close').conditions = { quantity: 2 };
  rejected(f, [['pain', 'core-a', 'close']], 'AI_ORDER_CONDITIONS');
});

test('source duration boundaries are exact and include the whole speech without trimming', () => {
  const checkDuration = (sourceMs, accepted) => {
    const f = fixture(), candidate = f.engineInput.candidates[4], cue = f.engineInput.cues[4];
    candidate.endMs = cue.endMs = candidate.startMs + sourceMs - 27000;
    if (accepted) assert.equal(validateAiStructureOrder(f, response()).plans[0].sourceDurationMs, sourceMs);
    else rejected(f, [['pain', 'core-a', 'close']], 'AI_ORDER_DURATION');
  };
  checkDuration(39000, true); checkDuration(52000, true); checkDuration(38999, false); checkDuration(52001, false);
});

test('display evidence must cover the whole selected unit and belong to the usable evidence source', () => {
  const f = fixture(); review(f, 'core-a').roles.push('display');
  rejected(f, [['pain', 'core-a', 'close']], 'AI_ORDER_DISPLAY');
  f.visualReview = { status: 'complete', entries: [{ startMs: 13000, endMs: 28000, productMatch: 'match', display: 'shown', evidenceTimesMs: [15000] }] };
  assert.equal(validateAiStructureOrder(f, response()).plans.length, 1);
  f.visualReviewStale = true; rejected(f, [['pain', 'core-a', 'close']], 'AI_ORDER_DISPLAY');
  f.visualReviewStale = false; f.visibility = 'shared'; f.compositionEvidence = {};
  rejected(f, [['pain', 'core-a', 'close']], 'AI_ORDER_DISPLAY');
});

test('no confirmed closing is not ready, and rejected output never manufactures completion', () => {
  const f = fixture(); review(f, 'close').status = 'pending';
  assert.equal(inspectAiOrderInput(f.engineInput).ready, false);
  const result = validateAiStructureOrder(f, response());
  assert.equal(result.modelComplete, false); assert.equal(result.plans.length, 0);
  assert.equal(getAiOrderCoverage(f, response().plans).covered, 0);
});
