import test from 'node:test';
import assert from 'node:assert/strict';
import { createAiStructureRequest, validateAiStructureResponse, AI_STRUCTURE_VERSION } from './ai-structure.mjs';
import { getAiPricedCoverage } from './ai-structure-priced.mjs';

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
