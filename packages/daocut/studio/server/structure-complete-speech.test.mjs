// Isolated invented transcripts: no provider, media, service or existing project access.
import test from 'node:test';
import assert from 'node:assert/strict';
import { enumerateStructureCompositions } from './structure-composition.mjs';

function fixture(specs) {
  let time = 0;
  const cues = [], candidates = [];
  for (const [id, roles, texts] of specs) {
    const first = cues.length, startMs = time;
    for (const text of texts) { cues.push({ startMs: time, endMs: time + 3000, text }); time += 3000; }
    candidates.push({ id, sourceId: 's', productId: 'p', intervalId: 'i', startMs, endMs: time,
      cueRange: [first, cues.length - 1], text: texts.join(''), tags: [],
      details: { composition: { contract: 'complete-speech-v1', status: 'confirmed', roles, requires: [], conditions: {}, excludes: [] } } });
    time += 1000;
  }
  return { scope: { sourceId: 's', productId: 'p', intervalId: 'i', startMs: 0, endMs: time }, sourceIdentity: 'synthetic-complete-speech', cues, candidates };
}
function all(input, options = {}) {
  const plans = []; let cursor = null, result;
  do {
    result = enumerateStructureCompositions(input, { limit: 200, stepBudget: 100000, ...options, cursor });
    plans.push(...result.plans); cursor = result.cursor;
  } while (!result.complete);
  return { ...result, plans };
}
const signature = plan => plan.clips.map(clip => clip.candidateId).join(',');

test('every complete non-purchase content role may open, without a prior hook tag', () => {
  for (const role of ['story', 'pain', 'core', 'display', 'offer', 'trust']) {
    const input = fixture([['opening', [role], ['完整开头原话']], ['selling', ['core'], ['完整卖点原话']], ['close', ['purchase'], ['需要的现在下单']]]);
    const result = all(input), plan = result.plans.find(plan => signature(plan) === 'opening,selling,close');
    assert.ok(plan, `${role} must be usable as an opening`);
    assert.deepEqual(plan.clips[0].roles, ['hook', role]);
    assert.equal(plan.clips[1].roles.includes('hook'), false);
    assert.equal(input.candidates[0].details.composition.roles.includes('hook'), false);
  }
});

test('purchase, including a bound offer/purchase unit, is only used as the ending', () => {
  const input = fixture([['a', ['core'], ['完整卖点']], ['c1', ['offer', 'purchase'], ['拍两件才送杯子，现在拍这个套餐']], ['c2', ['purchase'], ['需要就下单']]]);
  const result = all(input);
  assert.deepEqual(new Set(result.plans.map(signature)), new Set(['a,c1', 'a,c2']));
  assert.ok(result.plans.every(plan => plan.clips.slice(0, -1).every(clip => !clip.roles.includes('purchase'))));
});

test('counts one or two complete selling units, retaining alternative wording without semantic core IDs', () => {
  const input = fixture([['a', ['core'], ['杯盖拧紧倒过来也不漏']], ['b', ['core'], ['放包里不用担心弄湿东西']], ['d', ['core'], ['杯口很大，清洗方便']], ['c', ['purchase'], ['想要的现在拍']]]);
  const result = all(input);
  assert.ok(result.plans.some(plan => signature(plan) === 'a,b,c'));
  assert.ok(result.plans.some(plan => signature(plan) === 'b,a,c'));
  assert.ok(result.plans.some(plan => signature(plan) === 'a,c'));
  assert.ok(result.plans.some(plan => signature(plan) === 'b,c'));
  assert.ok(result.plans.every(plan => plan.clips.filter(clip => clip.roles.includes('core')).length <= 2));
  assert.ok(result.plans.every(plan => plan.coreIds.length >= 1 && plan.coreIds.length <= 2));
  assert.ok(Object.values(result.coreLabels).includes('杯盖拧紧倒过来也不漏'));
});

test('a continuous context/price/CTA unit remains whole and is not duplicated to fill roles', () => {
  const input = fixture([['sell', ['pain', 'core'], ['普通杯子放包里容易漏。', '这个杯盖有两道密封圈，所以不用担心这个问题。']], ['deal', ['offer', 'purchase'], ['今天拍两瓶领券后一共九十八。', '算下来一瓶四十九，需要的拍这个套餐。']]]);
  const result = all(input);
  assert.equal(result.plans.length, 1);
  assert.equal(signature(result.plans[0]), 'sell,deal');
  for (const clip of result.plans[0].clips) {
    const original = input.candidates.find(candidate => candidate.id === clip.candidateId);
    assert.deepEqual([clip.startMs, clip.endMs, clip.text], [original.startMs, original.endMs, original.text]);
    assert.equal(clip.speed, 1);
  }
});

test('body permutations are unchanged for a fixed opening; only opening eligibility changes', () => {
  const old = fixture([['h', ['hook'], ['原开头']], ['a', ['core'], ['完整卖点']], ['p', ['pain'], ['完整痛点']], ['f', ['offer'], ['完整福利']], ['c', ['purchase'], ['现在拍']]]);
  for (const candidate of old.candidates) {
    delete candidate.details.composition.contract;
    candidate.details.composition.coreIds = candidate.id === 'a' ? ['old-core'] : [];
  }
  const current = structuredClone(old);
  current.candidates.forEach(candidate => { candidate.details.composition.contract = 'complete-speech-v1'; });
  assert.deepEqual(new Set(all(current).plans.filter(plan => plan.clips[0].candidateId === 'h').map(signature)), new Set(all(old).plans.map(signature)));
});

test('missing source or semantic information stays explicit, and interrupted enumeration can resume', () => {
  const input = fixture([['s', ['story'], ['故事']], ['a', ['core'], ['卖点']], ['c', ['purchase'], ['购买']]]);
  const result = all(input, { limit: 1, stepBudget: 2 });
  assert.equal(result.allValidCombinationsEnumerated, true);
  assert.deepEqual(new Set(result.plans.map(signature)), new Set(all(input).plans.map(signature)));
  input.candidates[1].details.composition.status = 'needs-review';
  const missing = all(input);
  assert.equal(missing.plans.length, 0);
  assert.ok(missing.issues.some(issue => issue.code === 'MISSING_CORE'));
  assert.equal(missing.allValidCombinationsEnumerated, false);
});

test('unresolved analysis coverage is visible and never described as all material enumerated', () => {
  const input = fixture([['a', ['core'], ['完整卖点']], ['c', ['purchase'], ['现在拍']]]);
  input.analysisIssues = ['讲解后半段尚未检查'];
  const result = all(input);
  assert.ok(result.plans.length > 0);
  assert.equal(result.complete, true);
  assert.equal(result.materialComplete, false);
  assert.equal(result.allValidCombinationsEnumerated, false);
  assert.ok(result.issues.some(issue => issue.code === 'ANALYSIS_INCOMPLETE' && issue.message.includes('后半段')));
});
