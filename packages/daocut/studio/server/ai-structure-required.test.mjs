import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTextStructure, PREVIOUS_ATTRIBUTED_TEXT_STRUCTURE_PROMPT } from './text-structure.mjs';
import { createAiStructureRequest, validateAiStructureResponse } from './ai-structure.mjs';
import { AI_STRUCTURE_REQUIRED_VERSION as AI_STRUCTURE_VERSION, inspectAiRequiredInput } from './ai-structure-required.mjs';

async function fixture(priceKind = 'current') {
  const scope = { sourceId: 's', productId: 'p', intervalId: 'i', startMs: 0, endMs: 65000 };
  const rows = [
    ['今天介绍这款饭盒，双层结构。', ['产品介绍']],
    ['饭菜分开放，带到公司也方便。', ['卖点']],
    ['今天一套三十九元，含一个饭盒。', ['价格机制']],
    ['想要的朋友现在点一号链接拍。', ['行动指令']],
    ['今天还送一个保温袋。', ['福利机制']],
    ['普通单层饭盒也要六十九元。', ['价格机制']],
  ];
  const cues = rows.map(([text], n) => ({ text, startMs: n * 10000, endMs: (n + 1) * 10000 }));
  const candidates = rows.map(([, tags], n) => ({ firstCue: n, lastCue: n, tags, subject: { kind: n === 5 ? 'other' : 'self', evidence: [n] },
    ...(n === 0 ? { opening: { group: '饭盒介绍', followup: '接分隔功能' } } : {}),
    ...([2, 5].includes(n) ? { price: { kind: n === 5 ? 'reference' : priceKind, evidence: [n] } } : {}) }));
  const output = await analyzeTextStructure({ ...scope, rangeStartMs: 0, rangeEndMs: 65000, cues, client: async () => ({ schema: 'complete-speech-v1', candidates, issues: [] }) });
  return { scope, source: { id: 's', assetPath: 'assets/test.mp4' }, engineInput: { scope, sourceIdentity: 'test', cues, candidates: output.candidates }, visibility: 'local', issues: [] };
}
test('a current-price plan needs intro, core, quoted transaction price and final purchase; gift remains optional', async () => {
  const input = await fixture(), ids = input.engineInput.candidates.map(c => c.id);
  const response = indices => validateAiStructureResponse(input, { schema: AI_STRUCTURE_VERSION, plans: [indices.map(n => ids[n])] });
  assert.equal(response([0, 1, 2, 3]).plans.length, 1);
  assert.equal(response([0, 1, 4, 3]).plans.length, 0, 'a gift does not satisfy price');
  assert.equal(response([0, 4, 2, 3]).plans.length, 0, 'intro does not satisfy selling point');
  assert.equal(response([0, 1, 2, 4]).plans.length, 0, 'gift does not satisfy close');
  const core = input.engineInput.candidates[1].details.composition;
  core.opening = { group: '饭盒好处', followup: '说价格' };
  assert.equal(response([1, 4, 2, 3]).plans.length, 0, 'core does not satisfy intro');
  const body = JSON.parse(createAiStructureRequest(input, { version: AI_STRUCTURE_VERSION }).input);
  assert.deepEqual(body.rules.requiredRoles, ['intro', 'core', 'price', 'purchase']);
  assert.deepEqual(body.units.find(u => u.id === ids[2]).price, { kind: 'current', evidence: [0] });
  const combined = input.engineInput.candidates[0].details.composition;
  combined.roles.push('core', 'price'); combined.price = { kind: 'current', evidence: [0] };
  assert.equal(response([0, 4, 3]).plans.length, 0, 'duration still enforced');
  assert.equal(response([0, 4, 2, 3]).plans.length, 1, 'required content can share a clip');
});
test('reference and future prices cannot pass as actual transaction prices; evidence changes input identity', async () => {
  const current = await fixture(), reference = await fixture('reference'), future = await fixture('future');
  assert.equal(inspectAiRequiredInput(current.engineInput).ready, true);
  for (const input of [reference, future]) {
    assert.equal(inspectAiRequiredInput(input.engineInput).ready, false);
    assert.notEqual(inspectAiRequiredInput(input.engineInput).inputHash, inspectAiRequiredInput(current.engineInput).inputHash);
    assert.equal(validateAiStructureResponse(input, { schema: AI_STRUCTURE_VERSION, plans: [input.engineInput.candidates.slice(0, 4).map(c => c.id)] }).plans.length, 0);
  }
});
test('subject context can identify a short quote without merging that context; price evidence must be inside the quote', async () => {
  const cues = [{ startMs: 0, endMs: 1000, text: '我们这个饭盒' }, { startMs: 1000, endMs: 2000, text: '今天只要三十九元' }];
  const row = { firstCue: 1, lastCue: 1, tags: ['价格机制'], subject: { kind: 'self', evidence: [0] }, price: { kind: 'current', evidence: [1] } };
  const run = (candidate, extra = {}) => analyzeTextStructure({ sourceId: 's', productId: 'p', intervalId: 'i', rangeStartMs: 0, rangeEndMs: 2000, cues, client: async () => ({ schema: 'complete-speech-v1', candidates: [candidate], issues: [] }), ...extra });
  const result = await run(row);
  assert.equal(result.candidates[0].text, '今天只要三十九元');
  assert.equal(result.candidates[0].details.composition.status, 'confirmed');
  await assert.rejects(run({ ...row, price: { kind: 'current', evidence: [0] } }), /价格/);
  await assert.rejects(run(row, { prompt: PREVIOUS_ATTRIBUTED_TEXT_STRUCTURE_PROMPT }), /归属/);
});
