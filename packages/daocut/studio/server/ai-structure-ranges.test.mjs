import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectAiRangeInput, validateAiStructureRanges } from './ai-structure-ranges.mjs';

function fixture() {
  const scope = { sourceId: 's', productId: 'p', intervalId: 'i', startMs: 0, endMs: 100000 };
  const texts = ['头发打结梳不开吗。', '每次梳头都很费劲。', '还有朋友问我怎么选择。', '接下来讲清楚这个区别。',
    '先跟新来的朋友打个招呼。', '这款的使用方式很简单。', '这个泵头可以单手按。', '手湿也不用拧盖。', '按一下就能控制用量。', '不用两只手来回拧。', '两瓶领取优惠后是九十八。', '现在需要的可以拍。',
    '需要这个组合的点购买链接。', '认准现在这两瓶的规格。', '符合活动条件的现在下单。', '下完单记得核对数量。', '这是额外的独立卖点。', '这个设计便于收纳。', '另一次讲解即将开始。', '原片结束。'];
  const cues = texts.map((text, n) => ({ text, startMs: n * 5000, endMs: (n + 1) * 5000 }));
  const make = (id, first, last, roles) => ({ id, ...scope, startMs: cues[first].startMs, endMs: cues[last].endMs,
    text: cues.slice(first, last + 1).map(c => c.text).join(''), cueRange: [100 + first, 100 + last], tags: [],
    details: { review: ['仅依据 ASR；画面、声音和句级边界待核实'], composition: { contract: 'complete-speech-v1', status: 'confirmed', roles, requires: [], excludes: [], conditions: {} } } });
  const candidates = [make('intro', 0, 3, ['pain']), make('long', 4, 11, ['core', 'offer', 'purchase']), make('end', 12, 15, ['purchase']), make('extra', 16, 17, ['core'])];
  return { scope, context: scope, source: { id: 's', assetPath: 'assets/synthetic-only.mp4', durationMs: 100000 }, visibility: 'local',
    engineInput: { scope, sourceIdentity: 'synthetic-source-hash', cues, cueIndices: cues.map((_, n) => n + 100), candidates } };
}
const piece = (unit, firstCue, lastCue, tags, conditions) => ({ unit, firstCue, lastCue, tags, ...(conditions ? { conditions } : {}) });
const row = () => [piece(0, 100, 101, ['痛点']), piece(1, 106, 109, ['卖点']), piece(2, 112, 114, ['行动指令'])];
const response = (plans = [row()]) => ({ schema: 'ai-structure-plans-v2', plans, complete: true, issues: [] });
const rejected = (f, value, code) => { const result = validateAiStructureRanges(f, value); assert.equal(result.plans.length, 0); if (code) assert.ok(result.issues.some(issue => issue.code === code), JSON.stringify(result.issues)); return result; };

test('range readiness does not reject a long parent merely because its overall tag contains purchase', () => {
  const f = fixture();
  f.engineInput.candidates.forEach(c => { c.details.composition.roles = ['purchase']; });
  const result = inspectAiRangeInput(f.engineInput);
  assert.equal(result.ready, true);
  assert.ok(!result.issues.some(i => i.code.startsWith('MISSING_')));
  assert.equal(result.inputHash.length, 64);
});

test('v2 restores only selected complete cues at 1.3 speed, without changing parents or needing new transcript', () => {
  const f = fixture(), before = structuredClone(f);
  const result = validateAiStructureRanges(f, response());
  assert.equal(result.plans.length, 1);
  const plan = result.plans[0];
  assert.equal(plan.speed, 1.3); assert.equal(plan.version, 'ai-structure-plans-v2');
  assert.equal(plan.durationMs, 45000 / 1.3);
  assert.deepEqual(plan.clips[1].cueRange, [106, 109]);
  assert.equal(plan.clips[1].startMs, 30000); assert.equal(plan.clips[1].endMs, 50000);
  assert.equal(plan.clips[1].text, f.engineInput.cues.slice(6, 10).map(c => c.text).join(''));
  assert.equal(plan.clips[1].candidateId, 'long'); assert.equal(plan.clips[1].parentCandidateId, 'long');
  assert.equal(plan.clips[1].assetPath, 'assets/synthetic-only.mp4');
  assert.deepEqual(plan.clips[1].roles, ['core']);
  assert.equal(plan.clips[1].speed, 1.3);
  assert.equal(result.allValidCombinationsEnumerated, false);
  assert.deepEqual(result.sequences, [row()]);
  assert.deepEqual(f, before);
});

test('a complete non-purchase subrange of a mixed purchase parent can open, but retained purchase must remain last', () => {
  const f = fixture();
  const valid = [piece(1, 106, 109, ['卖点']), piece(0, 100, 102, ['痛点']), piece(2, 112, 113, ['行动指令'])];
  const plan = validateAiStructureRanges(f, response([valid])).plans[0];
  assert.ok(plan); assert.deepEqual(plan.clips[0].roles, ['hook', 'core']);
  rejected(f, response([[piece(1, 106, 109, ['卖点', '行动指令']), ...valid.slice(1)]]), 'AI_RANGE_STRUCTURE');
});

test('invalid refs, local/global cue confusion, outside-parent ranges and gaps never create a guessed cut', () => {
  for (const patch of [{ unit: 99 }, { firstCue: 6, lastCue: 9 }, { firstCue: 103, lastCue: 109 }, { firstCue: 106, lastCue: 118 }, { firstCue: 107, lastCue: 106 }]) {
    const list = row(); Object.assign(list[1], patch); rejected(fixture(), response([list]));
  }
  const f = fixture();
  f.engineInput.cues.splice(7, 1); f.engineInput.cueIndices.splice(7, 1);
  const parent = f.engineInput.candidates[1]; parent.text = f.engineInput.cues.filter((_, i) => f.engineInput.cueIndices[i] >= 104 && f.engineInput.cueIndices[i] <= 111).map(c => c.text).join('');
  rejected(f, response(), 'AI_RANGE_CUE_GAP');
});

test('raw text, source timestamps and unknown model fields cannot replace canonical source text', () => {
  const changed = response(); changed.plans[0][1].text = '模型编造的卖点';
  assert.throws(() => validateAiStructureRanges(fixture(), changed), /格式|字段/);
  assert.throws(() => validateAiStructureRanges(fixture(), { ...response(), schema: 'ai-structure-plans-v1' }), /格式|v2/);
  assert.throws(() => validateAiStructureRanges(fixture(), response([[piece(0, 100, 101, ['未知标签'])]])), /格式|标签/);
});

test('known required context must be selected in full before a dependent child, not bypassed by cropping', () => {
  const f = fixture(); f.engineInput.candidates[1].details.composition.requires = ['intro'];
  rejected(f, response(), 'AI_RANGE_CONTEXT');
  const good = [piece(0, 100, 103, ['痛点']), piece(1, 106, 108, ['卖点']), piece(2, 112, 113, ['行动指令'])];
  assert.equal(validateAiStructureRanges(f, response([good])).plans.length, 1);
  rejected(f, response([[good[1], good[0], good[2]]]), 'AI_RANGE_CONTEXT');
});

test('one continuous child can keep its recorded required context without replaying that context as another clip', () => {
  const makeInput = (contextFirst, contextLast) => {
    const scope = { sourceId: 's', productId: 'p', intervalId: 'i', startMs: 0, endMs: 45000 };
    const cues = [
      { startMs: 0, endMs: 5000, text: '这款泵头先给大家看清楚。' },
      { startMs: 5000, endMs: 10000, text: '手湿的时候不用拧盖。' },
      { startMs: 10000, endMs: 30000, text: '所以可以单手按，按一下就能控制用量。' },
      { startMs: 30000, endMs: 45000, text: '需要的点购买链接，核对数量下单。' },
    ];
    const candidate = (id, first, last, roles, requires = []) => ({ ...scope, id,
      startMs: cues[first].startMs, endMs: cues[last].endMs, cueRange: [first, last], text: cues.slice(first, last + 1).map(cue => cue.text).join(''), tags: [],
      details: { composition: { contract: 'complete-speech-v1', status: 'confirmed', roles, requires, excludes: [], conditions: {} } } });
    return { source: { id: 's', assetPath: 'assets/synthetic-only.mp4' }, scope, visibility: 'local', engineInput: { scope, cues, cueIndices: [0, 1, 2, 3],
      candidates: [candidate('context', contextFirst, contextLast, ['pain']), candidate('whole-core', 0, 2, ['core'], ['context']), candidate('close', 3, 3, ['purchase'])] } };
  };
  const complete = [piece(1, 0, 2, ['卖点']), piece(2, 3, 3, ['行动指令'])];
  for (const [first, last] of [[0, 1], [1, 1]]) {
    const f = makeInput(first, last);
    const accepted = validateAiStructureRanges(f, response([complete]));
    assert.equal(accepted.plans.length, 1, JSON.stringify(accepted.issues));
    assert.equal(accepted.plans[0].clips.length, 2, 'context stays in its original position inside the complete clip');
    assert.equal(accepted.plans[0].clips[0].text, f.engineInput.candidates[1].text);
    assert.equal(accepted.plans[0].durationMs, 45000 / 1.3);
    rejected(f, response([[piece(1, 2, 2, ['卖点']), complete[1]]]), 'AI_RANGE_CONTEXT');
  }
  rejected(makeInput(2, 2), response([complete]), 'AI_RANGE_CONTEXT', 'a dependency ending the clip cannot be prior context for retained later speech');
  rejected(makeInput(3, 3), response([complete]), 'AI_RANGE_CONTEXT', 'future outside content is not contained by the selected child');
});

test('known conditions cannot be erased, contradicted or mixed by leaving them out of the child', () => {
  const f = fixture(); f.engineInput.candidates[1].details.composition.conditions = { quantity: 2 };
  const good = validateAiStructureRanges(f, response()).plans[0];
  assert.deepEqual(good.clips[1].conditions, { quantity: 2 });
  const list = row(); list[1].conditions = { quantity: 1 }; rejected(f, response([list]), 'AI_RANGE_CONDITIONS');
  f.engineInput.candidates[2].details.composition.conditions = { quantity: 1 };
  rejected(f, response(), 'AI_RANGE_CONDITIONS');
  const malformed = row(); malformed[1].conditions = { quantity: [2] };
  assert.throws(() => validateAiStructureRanges(fixture(), response([malformed])), /格式|条件/);
});

test('rejected, unresolved or different-lecture parents are not promoted into valid small segments', () => {
  const f = fixture(); f.engineInput.candidates[1].details.composition.status = 'pending'; rejected(f, response(), 'AI_RANGE_PARENT');
  const other = fixture(); other.engineInput.candidates[1].intervalId = 'return'; rejected(other, response(), 'AI_RANGE_PARENT');
  const excluded = fixture(); excluded.engineInput.candidates[1].details.composition.excludes = ['end']; rejected(excluded, response(), 'AI_RANGE_EXCLUDED');
});

test('structure still needs an opening, one or two complete selling speeches, and a closing purchase', () => {
  rejected(fixture(), response([[piece(0, 100, 103, ['痛点']), piece(2, 112, 115, ['行动指令'])]]), 'AI_RANGE_STRUCTURE');
  rejected(fixture(), response([[piece(0, 100, 103, ['痛点']), piece(1, 106, 109, ['卖点'])]]), 'AI_RANGE_STRUCTURE');
  const many = [piece(0, 100, 101, ['卖点']), piece(1, 106, 107, ['卖点']), piece(3, 116, 117, ['卖点']), piece(2, 112, 114, ['行动指令'])];
  rejected(fixture(), response([many]), 'AI_RANGE_STRUCTURE');
});

test('duration is a hard 30–40 seconds at 1.3, includes source pauses and uses child lengths', () => {
  const f = fixture();
  rejected(f, response([[piece(0, 100, 100, ['痛点']), piece(1, 106, 108, ['卖点']), piece(2, 112, 114, ['行动指令'])]]), 'AI_RANGE_DURATION');
  rejected(f, response([[piece(0, 100, 103, ['痛点']), piece(1, 104, 109, ['卖点']), piece(2, 112, 114, ['行动指令'])]]), 'AI_RANGE_DURATION');
  const gaps = fixture(); gaps.engineInput.cues[6].endMs -= 1000;
  assert.equal(validateAiStructureRanges(gaps, response()).plans[0].durationMs, 45000 / 1.3, 'a real pause within a continuous selected range is not omitted');
});

test('duration accepts exactly thirty and forty seconds and rejects one source millisecond outside', () => {
  const short = fixture(), shortRow = row(); shortRow[2].lastCue = 113;
  short.engineInput.cues[9].endMs = 49000;
  assert.equal(validateAiStructureRanges(short, response([shortRow])).plans[0].durationMs, 30000);
  short.engineInput.cues[9].endMs--;
  rejected(short, response([shortRow]), 'AI_RANGE_DURATION');
  const long = fixture(), longRow = row(); longRow[0].lastCue = 103;
  long.engineInput.cues[9].endMs = 47000;
  assert.equal(validateAiStructureRanges(long, response([longRow])).plans[0].durationMs, 40000);
  long.engineInput.cues[9].endMs++;
  rejected(long, response([longRow]), 'AI_RANGE_DURATION');
});

test('deduplication uses actual playback, not parent IDs, tags or artificial contiguous split boundaries', () => {
  const f = fixture(), alias = structuredClone(f.engineInput.candidates[1]); alias.id = 'long-copy'; f.engineInput.candidates.push(alias);
  const aliasRow = row(); aliasRow[1].unit = 4;
  const split = [row()[0], piece(1, 106, 107, ['卖点']), piece(1, 108, 109, ['卖点']), row()[2]];
  const result = validateAiStructureRanges(f, response([row(), aliasRow, split]));
  assert.equal(result.plans.length, 1); assert.equal(result.sequences.length, 1);
  const alternative = row(); alternative[1] = piece(1, 105, 108, ['卖点']);
  assert.equal(validateAiStructureRanges(f, response([row(), alternative])).plans.length, 2, 'different complete source material remains a separate plan');
});

test('different IDs do not permit overlapping source playback', () => {
  const f = fixture(), alias = structuredClone(f.engineInput.candidates[1]); alias.id = 'overlap'; f.engineInput.candidates.push(alias);
  rejected(f, response([[piece(0, 100, 100, ['痛点']), piece(1, 106, 108, ['卖点']), piece(4, 108, 109, ['卖点']), piece(2, 112, 113, ['行动指令'])]]), 'AI_RANGE_OVERLAP');
});

test('display requires valid in-range saved public or local evidence and cannot use a different crop of the parent', () => {
  const f = fixture(), list = row(); list[1].tags.push('产品演示');
  rejected(f, response([list]), 'AI_RANGE_DISPLAY');
  f.visualReview = { status: 'complete', entries: [{ startMs: 20000, endMs: 60000, productMatch: 'match', display: 'shown', evidenceTimesMs: [55000], issues: [] }] };
  rejected(f, response([list]), 'AI_RANGE_DISPLAY');
  f.visualReview.entries[0].evidenceTimesMs = [35000];
  assert.equal(validateAiStructureRanges(f, response([list])).plans.length, 1);
  f.visibility = 'shared'; f.compositionEvidence = {};
  rejected(f, response([list]), 'AI_RANGE_DISPLAY');
});

test('all returned valid rows are retained, and model completeness remains distinct from exhaustive proof', () => {
  const f = fixture();
  const rows = [row(), [piece(0, 101, 102, ['痛点']), piece(1, 106, 109, ['卖点']), piece(2, 112, 114, ['行动指令'])]];
  const result = validateAiStructureRanges(f, { ...response(rows), complete: false, issues: ['还有其他开头未完成'] });
  assert.equal(result.plans.length, 2); assert.equal(result.modelComplete, false); assert.equal(result.allValidCombinationsEnumerated, false);
  assert.ok(result.issues.some(i => i.message === '还有其他开头未完成'));
});
