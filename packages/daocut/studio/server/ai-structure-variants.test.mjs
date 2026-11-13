import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AI_STRUCTURE_ORDER_VERSION, validateAiStructureOrder } from './ai-structure-order.mjs';
import { AI_STRUCTURE_VARIANTS_VERSION, AI_STRUCTURE_VARIANTS_PROMPT, inspectAiVariantsInput, createAiVariantsRequest, validateAiStructureVariants, getAiVariantsCoverage, planAiVariantBatches } from './ai-structure-variants.mjs';

function fixture() {
  const scope = { sourceId: 's', productId: 'p', intervalId: 'i', startMs: 0, endMs: 120000 };
  const data = [
    ['pain', 9000, '洗完头一梳就打结，早上赶时间很麻烦。', ['pain']],
    ['core-a', 15000, '这个泵头可以单手按，手湿也不用拧盖。', ['core']],
    ['core-b', 15000, '瓶身透明，剩余多少一眼就看清。', ['core']],
    ['offer', 9000, '同一瓶平时89，今天体验价59。', ['offer']],
    ['trust', 9000, '这个商品每一批都能查到对应批次。', ['trust']],
    ['close', 7000, '今天需要的点购买链接，核对规格后付款。', ['purchase']],
    ['close-b', 7000, '想试试的朋友点链接，现在选好规格购买。', ['purchase']],
    ['offer-a', 5000, '今天这一瓶的价格是59。', ['offer']],
    ['offer-b', 5000, '今天这一瓶还包邮。', ['offer']],
  ];
  let cursor = 0;
  const candidates = data.map(([id, duration, text, roles], index) => {
    const startMs = cursor, endMs = cursor + duration; cursor = endMs + 1000;
    return { id, ...scope, startMs, endMs, text, cueRange: [100 + index, 100 + index], tags: [], version: 'fixture',
      details: { review: ['仅依据 ASR；画面、声音和句级边界待核实'], composition: { contract: 'complete-speech-v1', status: 'confirmed', roles, requires: [], excludes: [], conditions: {} } } };
  });
  const cues = candidates.map(({ startMs, endMs, text }) => ({ startMs, endMs, text }));
  return { scope, context: scope, source: { id: 's', assetPath: 'assets/synthetic.mp4' }, visibility: 'local',
    engineInput: { scope, sourceIdentity: 'synthetic-sha', candidates, cues, cueIndices: cues.map((_, index) => 100 + index) } };
}
const base = ['pain', 'core-a', 'offer', 'close'];
const alternateCore = ['pain', 'core-b', 'offer', 'close'];
const response = (plans = [base]) => ({ schema: AI_STRUCTURE_VARIANTS_VERSION, plans });
const options = (extra = {}) => ({ openingIds: ['pain'], targetVariants: 3, ...extra });
const review = (f, id) => f.engineInput.candidates.find(item => item.id === id).details.composition;

test('v5 prompt review copy is exact and asks material-driven variants without a fixed count, meaningful order and ID-only output', async () => {
  const copy = await readFile(new URL('../../../../docs/prompts-review-20261111/03-compose-structure-v5.txt', import.meta.url), 'utf8');
  assert.equal(AI_STRUCTURE_VARIANTS_PROMPT, copy.replace(/\r\n/g, '\n').trim());
  assert.match(copy, /没有每个开头的固定条数或数量上限/); assert.match(copy, /只保留已有方案、零新增/);
  assert.match(copy, /不要找到第一种就停止/); assert.match(copy, /数量由素材决定/);
  assert.doesNotMatch(copy, /targetCounts|targetVariants|最低累计覆盖检查数/);
  assert.match(copy, /连续相同角色合并/); assert.match(copy, /不替代你对购买逻辑/);
  assert.match(copy, /拟改89当作现在也卖89/); assert.match(copy, /不要输出 complete/);
});

test('inspection keeps v4 whole-unit eligibility but has a separate v5 identity', () => {
  const f = fixture(), result = inspectAiVariantsInput(f.engineInput);
  assert.equal(result.ready, true); assert.equal(result.version, AI_STRUCTURE_VARIANTS_VERSION);
  assert.equal(result.eligibleCount, 9); assert.equal(result.openingIds.length, 7);
  assert.ok(!result.openingIds.includes('close')); assert.equal(result.inputHash.length, 64);
  review(f, 'core-b').requires = ['offer'];
  assert.ok(!inspectAiVariantsInput(f.engineInput).openingIds.includes('core-b'));
});

test('requests preserve a byte-identical static prefix across targets/history/feedback and include only related history', () => {
  const f = fixture(); f.transcript = 'PRIVATE FULL TRANSCRIPT'; f.mediaReview = { raw: 'TECHNICAL MEDIA' };
  f.visualReview = { status: 'complete', issues: ['specific visual note'], entries: [] };
  const anotherOpening = ['core-a', 'pain', 'offer', 'close'];
  const previous = [base, alternateCore, anotherOpening, base];
  const a = createAiVariantsRequest(f, options({ previous, feedback: [{ openingId: 'pain', message: 'keep me' }, { openingId: 'core-a', message: 'omit me' }] }));
  const b = createAiVariantsRequest(f, { openingIds: ['core-a'], targetVariants: 2, previous, feedback: [] });
  assert.equal(a.system, b.system);
  assert.equal(a.input.split(',"openingIds":')[0], b.input.split(',"openingIds":')[0]);
  const body = JSON.parse(a.input);
  assert.deepEqual(Object.keys(body), ['rules', 'units', 'visualReview', 'openingIds', 'targetVariants', 'previous', 'feedback']);
  assert.deepEqual(body.previous, [base, alternateCore]); assert.deepEqual(body.feedback, [{ openingId: 'pain', message: 'keep me' }]);
  assert.equal(body.units.length, 9); assert.ok(!a.input.includes('PRIVATE FULL TRANSCRIPT')); assert.ok(!a.input.includes('TECHNICAL MEDIA'));
  assert.ok(body.units.every(unit => !Object.hasOwn(unit, 'startMs') && !Object.hasOwn(unit, 'endMs')));
  assert.equal(body.targetVariants, 3); assert.deepEqual(JSON.parse(b.input).previous, [anotherOpening]);
});

test('request has no required variant target or hidden default count, while explicit statistics remain validated', () => {
  const f = fixture();
  const request = JSON.parse(createAiVariantsRequest(f, { openingIds: ['pain'], previous: [base] }).input);
  assert.deepEqual(Object.keys(request), ['rules', 'units', 'openingIds', 'previous', 'feedback']);
  assert.deepEqual(request.previous, [base]); assert.deepEqual(request.openingIds, ['pain']);
  assert.equal(request.targetVariants, undefined); assert.equal(request.targetCounts, undefined);
  for (const targetVariants of [0, -1, 1.5, '3']) assert.throws(() => createAiVariantsRequest(f, { targetVariants }), { code: 'AI_STRUCTURE_INVALID_RESPONSE' });
  assert.throws(() => createAiVariantsRequest(f, options({ openingIds: ['close'] })), { code: 'AI_STRUCTURE_INVALID_RESPONSE' });
  assert.throws(() => getAiVariantsCoverage(f, []), { code: 'AI_STRUCTURE_INVALID_RESPONSE' });
  assert.deepEqual(JSON.parse(createAiVariantsRequest(f, options({ openingIds: [] })).input).openingIds, []);
});

test('v4 seed plans remain byte-identical while v5 new plans restore exact source times and get separate IDs', () => {
  const f = fixture(), before = structuredClone(f);
  const seed = validateAiStructureOrder(f, { schema: AI_STRUCTURE_ORDER_VERSION, plans: [base] }).plans[0];
  const seedBefore = structuredClone(seed);
  const checked = validateAiStructureVariants(f, response([alternateCore]), options({ previous: [base] }));
  assert.equal(checked.plans.length, 1);
  const plan = checked.plans[0];
  assert.equal(plan.version, AI_STRUCTURE_VARIANTS_VERSION); assert.equal(plan.speed, 1.3);
  assert.equal(plan.sourceDurationMs, 40000); assert.equal(plan.durationMs, 40000 / 1.3);
  assert.deepEqual(plan.clips.map(clip => [clip.candidateId, clip.startMs, clip.endMs, clip.text, clip.cueRange]), alternateCore.map(id => {
    const c = f.engineInput.candidates.find(candidate => candidate.id === id); return [c.id, c.startMs, c.endMs, c.text, c.cueRange];
  }));
  const sameOrderV4 = validateAiStructureOrder(f, { schema: AI_STRUCTURE_ORDER_VERSION, plans: [alternateCore] }).plans[0];
  assert.notEqual(plan.id, sameOrderV4.id); assert.notEqual(plan.inputHash, sameOrderV4.inputHash);
  getAiVariantsCoverage(f, [seed.clips.map(clip => clip.candidateId), alternateCore], options());
  assert.deepEqual(seed, seedBefore); assert.deepEqual(f, before);
});

test('different core sets and support sets each count as material variants without synonym merging', () => {
  const f = fixture(), otherSupport = ['pain', 'core-a', 'trust', 'close'];
  const result = validateAiStructureVariants(f, response([base, alternateCore, otherSupport]), options());
  assert.equal(result.plans.length, 3); assert.equal(result.coverage.perOpening[0].distinctCount, 3);
  assert.equal(result.modelComplete, true); assert.equal(result.allValidCombinationsEnumerated, false);
});

test('same material with a different role order can count while an equivalent route returns feedback only', () => {
  const f = fixture(), reordered = ['pain', 'offer', 'core-a', 'close'];
  const result = validateAiStructureVariants(f, response([reordered, base]), options({ previous: [base] }));
  assert.deepEqual(result.sequences, [reordered]);
  assert.ok(result.issues.some(issue => issue.code === 'AI_VARIANT_NOT_DISTINCT' && issue.row === 1));
  assert.equal(result.coverage.perOpening[0].distinctCount, 2);
});

test('same-role swaps and purchase-only changes are not added as effective variants', () => {
  const f = fixture();
  const twoCores = ['pain', 'core-a', 'core-b', 'close'];
  const twoOffers = ['pain', 'core-a', 'offer-a', 'offer-b', 'close'];
  const previous = [base, twoCores, twoOffers];
  const repeatedRoutes = [['pain', 'core-a', 'offer', 'close-b'], ['pain', 'core-b', 'core-a', 'close'], ['pain', 'core-a', 'offer-b', 'offer-a', 'close']];
  const result = validateAiStructureVariants(f, response(repeatedRoutes), options({ previous }));
  assert.deepEqual(result.plans, []); assert.deepEqual(result.sequences, []);
  assert.equal(result.issues.filter(issue => issue.code === 'AI_VARIANT_NOT_DISTINCT').length, 3);
  const coverage = getAiVariantsCoverage(f, [...previous, ...repeatedRoutes], options());
  assert.equal(coverage.perOpening[0].savedCount, 6); assert.equal(coverage.perOpening[0].distinctCount, 3);
});

test('within-response route deduplication accepts the first version, does not inflate targets and keeps precise feedback rows', () => {
  const f = fixture();
  const result = validateAiStructureVariants(f, response([base, ['pain', 'core-a', 'offer', 'close-b'], alternateCore, base]), options());
  assert.deepEqual(result.sequences, [base, alternateCore]);
  assert.deepEqual(result.issues.map(issue => [issue.code, issue.row, issue.openingId]), [['AI_VARIANT_NOT_DISTINCT', 1, 'pain'], ['AI_VARIANT_NOT_DISTINCT', 3, 'pain']]);
  assert.equal(result.coverage.remainingVariants, 1); assert.equal(result.modelComplete, false);
});

test('different candidate IDs for the same actual source playback cannot duplicate a v5 plan', () => {
  const f = fixture(), alias = structuredClone(f.engineInput.candidates.find(item => item.id === 'core-a'));
  alias.id = 'core-alias'; f.engineInput.candidates.push(alias);
  const result = validateAiStructureVariants(f, response([base, ['pain', 'core-alias', 'offer', 'close']]), options());
  assert.equal(result.plans.length, 1); assert.equal(result.issues[0].code, 'AI_VARIANT_NOT_DISTINCT');
  assert.equal(result.coverage.totalDistinctVariants, 1);
});

test('the minimum target is not a maximum and completion never claims enumeration', () => {
  const result = validateAiStructureVariants(fixture(), response([base, alternateCore]), options({ targetVariants: 1 }));
  assert.equal(result.plans.length, 2); assert.equal(result.coverage.totalDistinctVariants, 2);
  assert.equal(result.coverage.remainingVariants, 0); assert.equal(result.modelComplete, true);
  assert.equal(result.allValidCombinationsEnumerated, false);
});

test('non-target openings, invalid source references and impossible duration never count', () => {
  const f = fixture();
  const result = validateAiStructureVariants(f, response([['core-a', 'pain', 'offer', 'close'], ['pain', 'unknown', 'offer', 'close'], ['pain', 'core-a', 'close'], base]), options());
  assert.deepEqual(result.sequences, [base]);
  assert.deepEqual(result.issues.map(issue => [issue.code, issue.row]), [['AI_VARIANT_OPENING_TARGET', 0], ['AI_ORDER_UNIT', 1], ['AI_ORDER_DURATION', 2]]);
  assert.equal(result.coverage.openingCovered, 1); assert.equal(result.coverage.covered, 0);
  assert.equal(getAiVariantsCoverage(f, [['pain', 'unknown', 'close']], options()).totalVariants, 0);
});

test('v4 source, price-role, dependency and display checks remain enforced under v5', () => {
  const f = fixture(); review(f, 'offer').conditions = { currentPrice: 59, referencePrice: 89 }; review(f, 'close').conditions = { futurePrice: 89 };
  assert.equal(validateAiStructureVariants(f, response(), options()).plans.length, 1);
  review(f, 'offer').conditions = { price: 59 }; review(f, 'close').conditions = { price: 89 };
  assert.equal(validateAiStructureVariants(f, response(), options()).issues[0].code, 'AI_ORDER_PRICE_METADATA');
  const dependency = fixture(); review(dependency, 'core-a').requires = ['trust'];
  assert.equal(validateAiStructureVariants(dependency, response(), options()).issues[0].code, 'AI_ORDER_CONTEXT');
  const display = fixture(); review(display, 'core-a').roles.push('display');
  assert.equal(validateAiStructureVariants(display, response(), options()).issues[0].code, 'AI_ORDER_DISPLAY');
  const changed = fixture(); changed.engineInput.candidates[1].text = '改过的原话';
  assert.equal(validateAiStructureVariants(changed, response(), options()).issues[0].code, 'AI_ORDER_UNIT');
});

test('strict v5 result rejects timestamp/object/label/schema/completion additions', () => {
  for (const value of [{ ...response(), complete: true }, { ...response(), issues: [] }, { ...response(), schema: AI_STRUCTURE_ORDER_VERSION },
    response([[{ id: 'pain', startMs: 0 }]]), response([[1, 2, 3]]), response([[]])]) {
    assert.throws(() => validateAiStructureVariants(fixture(), value, options()), { code: 'AI_STRUCTURE_INVALID_RESPONSE' });
  }
});

test('coverage exposes saved counts, distinct counts and remaining targets per opening, excluding invalid seeds', () => {
  const f = fixture(), other = ['core-a', 'pain', 'offer', 'close'];
  const coverage = getAiVariantsCoverage(f, [base, alternateCore, other, ['pain', 'missing', 'close'], base], { targetVariants: 2 });
  assert.equal(coverage.total, 7); assert.equal(coverage.targetVariants, 2);
  assert.equal(coverage.totalVariants, 3); assert.equal(coverage.totalDistinctVariants, 3);
  assert.equal(coverage.openingCovered, 2); assert.equal(coverage.covered, 1); assert.equal(coverage.remainingVariants, 11);
  assert.deepEqual(coverage.perOpening.find(item => item.openingId === 'pain'), { openingId: 'pain', targetVariants: 2, savedCount: 2, distinctCount: 2, remaining: 0 });
  assert.ok(coverage.excluded.find(item => item.id === 'close').reason.includes('结尾'));
  assert.equal(validateAiStructureVariants(f, response([]), options()).modelComplete, false);
});

test('recovery validation can omit optional history/target but does not manufacture completion', () => {
  const result = validateAiStructureVariants(fixture(), response());
  assert.equal(result.plans.length, 1); assert.equal(result.modelComplete, false); assert.equal(result.coverage, undefined);
});

test('per-opening minimum totals work without a fixed common target and only current targets enter the request', () => {
  const f = fixture(), targetCounts = { pain: 2, 'core-a': 4 };
  const request = createAiVariantsRequest(f, { openingIds: ['pain'], targetCounts, previous: [base] });
  const body = JSON.parse(request.input);
  assert.equal(body.targetVariants, undefined); assert.deepEqual(body.targetCounts, { pain: 2 });
  const result = validateAiStructureVariants(f, response([alternateCore, ['pain', 'offer', 'core-a', 'close']]), { openingIds: ['pain'], targetCounts, previous: [base] });
  assert.equal(result.plans.length, 2); assert.equal(result.coverage.targetVariants, null);
  assert.deepEqual(result.coverage.targetCounts, { pain: 2 }); assert.equal(result.coverage.totalDistinctVariants, 3);
  assert.equal(result.modelComplete, true);
  const mixed = getAiVariantsCoverage(f, [base], { openingIds: ['pain', 'core-a'], targetVariants: 2, targetCounts: { 'core-a': 4 } });
  assert.deepEqual(mixed.targetCounts, { pain: 2, 'core-a': 4 }); assert.equal(mixed.remainingVariants, 5);
  for (const bad of [{ pain: 0 }, { unknown: 2 }, { pain: 1.5 }, {}]) {
    assert.throws(() => createAiVariantsRequest(f, { openingIds: ['pain'], targetCounts: bad }), { code: 'AI_STRUCTURE_INVALID_RESPONSE' });
  }
});

test('batch planner groups by explicitly supplied pending-output budget rather than a hidden opening count', () => {
  const coverage = { perOpening: [{ openingId: 'a', remaining: 2 }, { openingId: 'b', remaining: 0 }, { openingId: 'c', remaining: 1 }, { openingId: 'd', remaining: 2 }] };
  assert.equal(planAiVariantBatches(coverage).ready, false);
  assert.deepEqual(planAiVariantBatches(coverage, { maxTargetVariantsPerRequest: 3 }).batches,
    [{ openingIds: ['a', 'c'], targetOutputCount: 3 }, { openingIds: ['d'], targetOutputCount: 2 }]);
  const tooSmall = planAiVariantBatches(coverage, { maxTargetVariantsPerRequest: 1 });
  assert.equal(tooSmall.ready, false); assert.deepEqual(tooSmall.batches, []); assert.deepEqual(tooSmall.overBudgetOpeningIds, ['a', 'd']);
  assert.deepEqual(planAiVariantBatches({ perOpening: [] }, { maxTargetVariantsPerRequest: 3 }).batches, []);
});
