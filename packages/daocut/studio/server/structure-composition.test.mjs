// Pure, invented fixtures. No media, project, NAS, provider or server access.
import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectCompositionInput, enumerateStructureCompositions, STRUCTURE_COMPOSITION_VERSION } from './structure-composition.mjs';

function fixture(specs = [
  ['h', '先看看这个问题', ['hook'], [], 5000],
  ['a', '特点甲带来具体好处', ['core'], ['benefit-a'], 10000],
  ['b', '特点乙适合另一种需要', ['core'], ['benefit-b'], 15000],
  ['c', '需要的现在点击链接购买', ['purchase'], [], 5000],
]) {
  let at = 0;
  const candidates = [], cues = [], entries = [];
  for (const [id, text, roles, coreIds, duration] of specs) {
    const index = cues.length;
    cues.push({ startMs: at, endMs: at + duration, text });
    candidates.push({ id, sourceId: 'local-source', productId: 'local-product', intervalId: 'local-interval', startMs: at, endMs: at + duration, text, tags: [], cueRange: [index, index], origin: 'synthetic-test', version: 1 });
    entries.push({ candidateId: id, status: 'confirmed', roles, coreIds, requires: [], conditions: {}, excludes: [] });
    at += duration + 1000;
  }
  return { sourceIdentity: 'shared-video-content-v1', scope: { sourceId: 'local-source', productId: 'local-product', intervalId: 'local-interval', startMs: 0, endMs: at + 1000 }, candidates, cues, semanticReview: { version: 1, coreLabels: { 'benefit-a': '核心好处甲', 'benefit-b': '核心好处乙' }, entries } };
}

function all(input, options = {}) {
  const plans = [];
  let cursor = null, result;
  for (let calls = 0; calls < 10000; calls++) {
    result = enumerateStructureCompositions(input, { limit: 17, stepBudget: 43, ...options, cursor });
    plans.push(...result.plans);
    if (result.complete) return { ...result, plans };
    cursor = JSON.parse(JSON.stringify(result.cursor));
  }
  assert.fail('finite fixture did not finish');
}
const signature = plan => plan.clips.map(clip => clip.candidateId).join(',');
const entry = (input, id) => input.semanticReview.entries.find(value => value.candidateId === id);

test('enumerates the exact complete set, including both core orders and optional material', () => {
  const input = fixture([
    ['h', '开头吸引原话', ['hook'], [], 5000],
    ['a', '核心好处甲', ['core'], ['benefit-a'], 10000],
    ['b', '核心好处乙', ['core'], ['benefit-b'], 15000],
    ['c', '点击购买', ['purchase'], [], 5000],
    ['p', '实际场景和顾虑的完整说明', ['pain'], [], 60000],
  ]);
  const result = all(input);
  assert.deepEqual(new Set(result.plans.map(signature)), new Set([
    'h,a,c', 'h,b,c', 'h,a,b,c', 'h,b,a,c',
    'h,p,a,c', 'h,a,p,c', 'h,p,b,c', 'h,b,p,c',
    'h,p,a,b,c', 'h,p,b,a,c', 'h,a,p,b,c', 'h,b,p,a,c', 'h,a,b,p,c', 'h,b,a,p,c',
  ]));
  assert.equal(result.allValidCombinationsEnumerated, true);
  assert.equal(result.plans.every(plan => plan.speed === 1 && plan.clips.every(clip => clip.speed === 1)), true);
  assert.ok(result.plans.some(plan => plan.durationMs < 30000));
  assert.ok(result.plans.some(plan => plan.durationMs > 50000));
  assert.ok(result.plans.every(plan => plan.version === STRUCTURE_COMPOSITION_VERSION));
  assert.ok(result.plans.every(plan => plan.scope.intervalId === input.scope.intervalId));
});

test('30–50 seconds is descriptive only; no speed change or rejection outside it', () => {
  for (const [durationMs, referenceDuration] of [[29000, 'short'], [30000, 'reference'], [50000, 'reference'], [51000, 'long']]) {
    const input = fixture([['whole', '完整钩子核心特点以及点击购买的原话', ['hook', 'core', 'purchase'], ['benefit-a'], durationMs]]);
    const result = all(input);
    assert.equal(result.plans.length, 1);
    assert.equal(result.plans[0].durationMs, durationMs);
    assert.equal(result.plans[0].referenceDuration, referenceDuration);
    assert.equal(result.plans[0].speed, 1);
  }
});

test('requires a hook, one or two distinct core identities and an actual purchase role', () => {
  for (const role of ['hook', 'core', 'purchase']) {
    const input = fixture();
    input.semanticReview.entries = input.semanticReview.entries.map(value => ({ ...value, roles: value.roles.filter(item => item !== role), ...(role === 'core' ? { coreIds: [] } : {}) }));
    const result = all(input);
    assert.equal(result.plans.length, 0);
    assert.ok(result.issues.some(issue => issue.code === `MISSING_${role.toUpperCase()}`));
  }
  const input = fixture([
    ['h', '吸引句', ['hook'], [], 1000], ['a', '卖点甲', ['core'], ['a'], 1000],
    ['b', '卖点乙', ['core'], ['b'], 1000], ['d', '卖点丙', ['core'], ['d'], 1000], ['c', '立即下单', ['purchase'], [], 1000],
  ]);
  assert.ok(all(input).plans.every(plan => plan.coreIds.length >= 1 && plan.coreIds.length <= 2));
});

test('retains different expressions of one core; they do not become two distinct cores', () => {
  const input = fixture();
  entry(input, 'b').coreIds = ['benefit-a'];
  const plans = all(input).plans;
  assert.ok(plans.some(plan => signature(plan) === 'h,a,c'));
  assert.ok(plans.some(plan => signature(plan) === 'h,b,c'));
  assert.ok(plans.some(plan => signature(plan) === 'h,b,a,c'));
  assert.ok(plans.every(plan => plan.coreIds.length === 1));
  assert.equal(plans[0].coreLabels['benefit-a'], '核心好处甲');
});

test('explicit alternatives and incompatible purchase conditions never get mixed', () => {
  const input = fixture();
  entry(input, 'a').excludes = ['b'];
  assert.deepEqual(new Set(all(input).plans.map(signature)), new Set(['h,a,c', 'h,b,c']));
  entry(input, 'a').excludes = [];
  entry(input, 'a').conditions = { offerRound: 'one' };
  entry(input, 'b').conditions = { offerRound: 'two' };
  entry(input, 'c').conditions = { offerRound: 'one' };
  assert.deepEqual(all(input).plans.map(signature), ['h,a,c']);
});

test('includes in-scope antecedents in order and counts their actual duration', () => {
  const input = fixture([
    ['context', '今天讲的是这个具体规格', [], [], 4000],
    ['h', '它为什么适合这个问题', ['hook'], [], 5000],
    ['a', '具体特点甲', ['core'], ['benefit-a'], 10000],
    ['c', '点击对应规格购买', ['purchase'], [], 5000],
  ]);
  entry(input, 'h').requires = ['context'];
  const result = all(input);
  assert.deepEqual(result.plans.map(signature), ['context,h,a,c']);
  assert.equal(result.plans[0].durationMs, 24000);
});

test('never obtains context from another product lecture or an out-of-scope sentence', () => {
  const input = fixture();
  const previous = { ...input.candidates[0], id: 'earlier-return', intervalId: 'other-interval', startMs: 0, endMs: 1000 };
  input.candidates.push(previous);
  entry(input, 'h').requires = ['earlier-return'];
  const result = all(input);
  assert.equal(result.plans.length, 0);
  assert.ok(result.issues.some(issue => issue.candidateId === 'h' && issue.code === 'DEPENDENCY_OUTSIDE_SCOPE'));
  assert.equal(result.materialComplete, false);
});

test('dependency cycles and dangling contextual material cannot yield a valid plan', () => {
  const input = fixture();
  entry(input, 'a').requires = ['b']; entry(input, 'b').requires = ['a'];
  const result = all(input);
  assert.equal(result.plans.length, 0);
  assert.ok(result.issues.some(issue => issue.code === 'DEPENDENCY_CYCLE'));
});

test('preserves exact ASR quotes and rejects fabricated text or unsupported boundaries', () => {
  const input = fixture();
  input.candidates[1].text += '新增原片没有的宣传';
  input.candidates[2].startMs += 1;
  const result = all(input);
  assert.equal(result.plans.length, 0);
  assert.ok(result.issues.some(issue => issue.candidateId === 'a' && issue.code === 'QUOTE_MISMATCH'));
  assert.ok(result.issues.some(issue => issue.candidateId === 'b' && issue.code === 'BOUNDARY_UNVERIFIED'));
});

test('old exact cue spans can be reused without cueRange; scoped cue indices remain traceable', () => {
  const input = fixture();
  input.candidates.forEach(candidate => { delete candidate.cueRange; });
  const result = all(input);
  assert.equal(result.plans.length, 4);
  assert.ok(result.plans.every(plan => plan.clips.every(clip => Array.isArray(clip.cueRange))));
  input.cueIndices = [10, 11, 12, 13];
  input.candidates.forEach((candidate, index) => { candidate.cueRange = [10 + index, 10 + index]; });
  assert.equal(all(input).plans.length, 4);
});

test('missing semantic fields are explicit issues, not guessed from legacy empty context', () => {
  const input = fixture();
  input.candidates[0].tags = ['钩子'];
  input.candidates[0].details = { context: '', repetition: '', reason: '旧分析理由', review: ['待核对'], subtypes: [], evidence: ['ASR'] };
  delete entry(input, 'h').requires;
  delete entry(input, 'a').conditions;
  delete entry(input, 'b').coreIds;
  const inspection = inspectCompositionInput(input);
  assert.equal(inspection.materialComplete, false);
  assert.ok(inspection.issues.some(issue => issue.candidateId === 'h' && issue.code === 'DEPENDENCIES_UNREVIEWED'));
  assert.ok(inspection.issues.some(issue => issue.candidateId === 'a' && issue.code === 'CONDITIONS_UNREVIEWED'));
  assert.ok(inspection.issues.some(issue => issue.candidateId === 'b' && issue.code === 'CORE_UNREVIEWED'));
  assert.equal(inspection.reviewItems.find(item => item.candidateId === 'h').details.reason, '旧分析理由');
});

test('reuses an existing explicitly confirmed structured record without requiring a new model result', () => {
  const input = fixture();
  input.candidates.forEach(candidate => {
    candidate.details = { composition: { ...entry(input, candidate.id) }, context: '' };
  });
  delete input.semanticReview;
  assert.equal(all(input).plans.length, 4);
});

test('deduplicates actual identical playback, but retains same words at another source position', () => {
  const input = fixture();
  input.candidates.push({ ...input.candidates[1], id: 'a-duplicate' });
  input.semanticReview.entries.push({ ...entry(input, 'a'), candidateId: 'a-duplicate' });
  assert.equal(all(input).plans.length, 4);
  input.cues[2].text = input.cues[1].text;
  input.candidates[2].text = input.candidates[1].text;
  entry(input, 'b').coreIds = ['benefit-a'];
  const result = all(input);
  assert.equal(result.plans.length, 4);
  assert.equal(new Set(result.plans.map(plan => plan.id)).size, 4);
});

test('overlapping source words never replay, and adjacent segmentation aliases deduplicate', () => {
  const input = fixture([
    ['h', '钩子', ['hook'], [], 1000], ['a', '卖点甲', ['core'], ['a'], 1000], ['b', '证据乙', ['trust'], [], 1000], ['c', '现在购买', ['purchase'], [], 1000],
  ]);
  // Make two cue ranges contiguous; a wide candidate expresses exactly the same source playback.
  const delta = input.candidates[2].startMs - input.candidates[1].endMs;
  input.cues[2].startMs -= delta; input.cues[2].endMs -= delta;
  input.candidates[2].startMs -= delta; input.candidates[2].endMs -= delta;
  const wide = { ...input.candidates[1], id: 'wide', endMs: input.candidates[2].endMs, text: input.candidates[1].text + input.candidates[2].text, cueRange: [1, 2] };
  input.candidates.push(wide);
  input.semanticReview.entries.push({ ...entry(input, 'a'), candidateId: 'wide', roles: ['core', 'trust'] });
  const result = all(input);
  assert.equal(result.plans.filter(plan => plan.clips.some(clip => clip.candidateId === 'wide') || signature(plan) === 'h,a,b,c').length, 1);
  assert.ok(result.plans.every(plan => plan.clips.every((clip, index) => plan.clips.every((other, j) => index === j || clip.endMs <= other.startMs || other.endMs <= clip.startMs))));
});

test('paged and interrupted enumeration is identical, with no hidden top-K or fragment count cap', () => {
  const input = fixture([
    ['h', '钩子', ['hook'], [], 1000], ['a', '核心', ['core'], ['a'], 1000],
    ...Array.from({ length: 5 }, (_, n) => [`optional-${n}`, `不同必要细节${n}`, ['trust'], [], 1000]),
    ['c', '下单', ['purchase'], [], 1000],
  ]);
  const first = enumerateStructureCompositions(input, { limit: 3, stepBudget: 2 });
  assert.equal(first.complete, false);
  assert.equal(first.allValidCombinationsEnumerated, false);
  assert.ok(first.cursor);
  const paged = all(input, { limit: 7, stepBudget: 97 });
  const large = all(input, { limit: 10000, stepBudget: 1000000 });
  assert.ok(paged.plans.length > 1000);
  assert.ok(paged.plans.some(plan => plan.clips.length === 8));
  assert.deepEqual(new Set(paged.plans.map(plan => plan.id)), new Set(large.plans.map(plan => plan.id)));
  assert.equal(paged.stats.emitted, paged.plans.length);
  assert.equal(paged.cursor, null);
});

test('cursor is bound to actual scope/material/semantic inputs and is not silently restarted', () => {
  const input = fixture();
  const first = enumerateStructureCompositions(input, { stepBudget: 1 });
  const changed = structuredClone(input);
  entry(changed, 'a').conditions = { price: 'different' };
  assert.throws(() => enumerateStructureCompositions(changed, { cursor: first.cursor }), error => error.code === 'COMPOSITION_INPUT_CHANGED');
  assert.throws(() => enumerateStructureCompositions(input, { cursor: { ...first.cursor, path: [999] } }), error => error.code === 'COMPOSITION_CURSOR_INVALID');
});

test('public stable identity ignores local source/product/interval/candidate IDs', () => {
  const input = fixture();
  const other = structuredClone(input);
  const ids = new Map(other.candidates.map(candidate => [candidate.id, `other-${candidate.id}`]));
  other.scope = { ...other.scope, sourceId: 'computer-b-source', productId: 'computer-b-product', intervalId: 'computer-b-interval' };
  other.candidates.forEach(candidate => { Object.assign(candidate, { id: ids.get(candidate.id), sourceId: other.scope.sourceId, productId: other.scope.productId, intervalId: other.scope.intervalId }); });
  other.semanticReview.entries.forEach(value => { value.candidateId = ids.get(value.candidateId); });
  const left = all(input), right = all(other);
  assert.equal(left.inputHash, right.inputHash);
  assert.deepEqual(left.plans.map(plan => plan.id), right.plans.map(plan => plan.id));
  assert.equal(right.plans[0].clips[0].sourceId, 'computer-b-source');
});

test('one unknown candidate does not erase known results or pretend all material was enumerated', () => {
  const input = fixture();
  input.semanticReview.entries = input.semanticReview.entries.filter(value => value.candidateId !== 'b');
  const result = all(input);
  assert.deepEqual(result.plans.map(signature), ['h,a,c']);
  assert.equal(result.complete, true);
  assert.equal(result.materialComplete, false);
  assert.equal(result.allValidCombinationsEnumerated, false);
  assert.ok(result.issues.some(issue => issue.candidateId === 'b' && issue.code === 'SEMANTICS_UNREVIEWED'));
});

test('context for a later core cannot be placed before an unrelated opening hook', () => {
  const input = fixture([
    ['context', '该比较所指的旧款规格', [], [], 1000],
    ['h', '这个购买问题值得看看', ['hook'], [], 1000],
    ['a', '相比刚才这个规格更轻便', ['core'], ['a'], 1000],
    ['c', '需要的点击购买', ['purchase'], [], 1000],
  ]);
  entry(input, 'a').requires = ['context'];
  assert.deepEqual(all(input).plans.map(signature), ['h,context,a,c']);
});

test('adjacent hook/core role boundaries do not fabricate an additional identical plan', () => {
  const input = fixture([
    ['h', '吸引句', ['hook'], [], 1000], ['a', '核心甲', ['core'], ['a'], 1000], ['c', '购买动作', ['purchase'], [], 1000],
  ]);
  input.cues[1].startMs = input.candidates[1].startMs = input.candidates[0].endMs;
  input.cues[1].endMs = input.candidates[1].endMs = input.candidates[1].startMs + 1000;
  input.candidates.push({ ...input.candidates[0], id: 'hook-core', endMs: input.candidates[1].endMs, text: '吸引句核心甲', cueRange: [0, 1] });
  input.semanticReview.entries.push({ candidateId: 'hook-core', status: 'confirmed', roles: ['hook', 'core'], coreIds: ['a'], requires: [], conditions: {} });
  const result = all(input, { limit: 1, stepBudget: 3 });
  assert.equal(result.plans.length, 1);
  assert.equal(result.plans[0].durationMs, 3000);
  assert.deepEqual(result.plans[0].coreIds, ['a']);
  assert.equal(result.plans[0].clips[0].roles.includes('hook'), true);
});

test('missing or unordered cue records give actionable boundary issues rather than inventing order', () => {
  for (const mode of ['missing', 'null-cue', 'unordered']) {
    const input = fixture();
    if (mode === 'missing') input.cues = [];
    if (mode === 'null-cue') input.cues[1] = null;
    if (mode === 'unordered') {
      const first = input.cues[1], second = input.cues[2];
      input.cues[1] = second; input.cues[2] = first;
      input.candidates[1] = { ...input.candidates[1], endMs: second.endMs, text: second.text + first.text, cueRange: [1, 2] };
    }
    const result = all(input);
    assert.ok(result.issues.some(issue => issue.code === 'BOUNDARY_UNVERIFIED'));
    if (mode !== 'missing') assert.ok(result.plans.every(plan => !plan.clips.some(clip => clip.candidateId === 'a')));
  }
});
