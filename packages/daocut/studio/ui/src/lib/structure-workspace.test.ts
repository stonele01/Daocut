import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupStructurePlans, groupStructurePlansByOpening, isSavedStructurePlanUsable, needsStructureGeneration, previewPosition, structureGroupLabel, type StructurePlan, type StructurePlansState } from './structure-workspace.ts';
import { registerDraftFlush, settleDraftWrites, trackDraftWrite } from './draft-save-barrier.ts';

test('production actions never offer another generation pass for completed results or legacy seeds', () => {
  const state: StructurePlansState = { status: 'idle', plans: [] };
  assert.equal(needsStructureGeneration(state), true);
  assert.equal(needsStructureGeneration(null), false);
  Object.assign(state, { status: 'complete', complete: true, canContinue: true, requestCount: 9 });
  assert.equal(needsStructureGeneration(state), false);
  state.complete = false;
  state.coverage = { total: 35, covered: 8, openingIds: ['a'], remainingIds: ['a'], excluded: [] };
  assert.equal(needsStructureGeneration(state), true, 'a submitted unfinished job can resume');
  state.requestCount = 0;
  assert.equal(needsStructureGeneration(state), false, 'saved seed plans must not open a supplemental pass');
  for (const status of ['running', 'failed', 'busy', 'publish-pending', 'unavailable'] as const) {
    state.status = status; state.requestCount = 1;
    assert.equal(needsStructureGeneration(state), false, 'recovery and publication have separate explicit controls');
  }
});

test('preview clock follows a discontiguous source sequence without changing a plan or editor', () => {
  const plan = { clips: [{ startMs: 20000, endMs: 24000 }, { startMs: 1000, endMs: 6000 }] };
  const original = JSON.stringify(plan);
  assert.deepEqual(previewPosition(plan, 4500), { index: 1, sourceMs: 1500, offsetMs: 4000 });
  assert.deepEqual(previewPosition(plan, 9000), { index: 1, sourceMs: 6000, offsetMs: 4000 });
  assert.equal(JSON.stringify(plan), original);
});

test('1.3x subclip preview maps edited clock to exact original boundaries and keeps old plans at 1x', () => {
  const plan = { speed: 1.3 as const, clips: [
    { startMs: 1200, endMs: 3800, speed: 1.3 as const },
    { startMs: 6400, endMs: 10300, speed: 1.3 as const },
    { startMs: 16000, endMs: 17300, speed: 1.3 as const },
  ] };
  const before = JSON.stringify(plan);
  assert.deepEqual(previewPosition(plan, 1000), { index: 0, sourceMs: 2500, offsetMs: 0 });
  assert.deepEqual(previewPosition(plan, 2000), { index: 1, sourceMs: 6400, offsetMs: 2000 });
  assert.deepEqual(previewPosition(plan, 4000), { index: 1, sourceMs: 9000, offsetMs: 2000 });
  assert.deepEqual(previewPosition(plan, 5000), { index: 2, sourceMs: 16000, offsetMs: 5000 });
  assert.deepEqual(previewPosition(plan, 6000), { index: 2, sourceMs: 17300, offsetMs: 5000 });
  assert.deepEqual(previewPosition(plan, 6500), { index: 2, sourceMs: 17300, offsetMs: 5000 });
  assert.equal(JSON.stringify(plan), before);
  assert.deepEqual(previewPosition({ ...plan, speed: 1 as const, clips: plan.clips.map(({ speed, ...clip }) => clip) }, 3000), { index: 1, sourceMs: 6800, offsetMs: 2600 });
});

test('1.3x plan speed also applies when older serialized clips omit their speed', () => {
  const plan = { speed: 1.3 as const, clips: [{ startMs: 4000, endMs: 6600 }, { startMs: 8000, endMs: 9300 }] };
  assert.deepEqual(previewPosition(plan, 2500), { index: 1, sourceMs: 8650, offsetMs: 2000 });
});

test('grouping preserves different hooks, wording and ordering; never slices the result count', () => {
  const plans = Array.from({ length: 151 }, (_, n) => ({ id: `p${n}`, coreIds: n % 2 ? ['a', 'b'] : ['b', 'a'] }));
  const grouped = groupStructurePlans(plans);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0]!.plans.length, 151);
  assert.deepEqual(grouped[0]!.plans.map(p => p.id), plans.map(p => p.id));
});

test('selling-point group names use confirmed labels in stable order without changing plans', () => {
  const coreLabels = { capacity: '500 毫升容量', 'one-hand': '单手按压开盖' };
  const plans = [
    { id: 'first-hook', coreIds: ['one-hand', 'capacity'], coreLabels },
    { id: 'second-hook', coreIds: ['capacity', 'one-hand'], coreLabels },
    { id: 'capacity-only', coreIds: ['capacity'], coreLabels },
  ];
  const before = JSON.stringify(plans);
  const groups = groupStructurePlans(plans);
  assert.equal(structureGroupLabel(plans[0]!), '500 毫升容量＋单手按压开盖');
  assert.equal(structureGroupLabel(plans[1]!), structureGroupLabel(plans[0]!));
  assert.deepEqual(groups.map(group => ({ label: structureGroupLabel(group.plans[0]!), ids: group.plans.map(plan => plan.id) })), [
    { label: '500 毫升容量＋单手按压开盖', ids: ['first-hook', 'second-hook'] },
    { label: '500 毫升容量', ids: ['capacity-only'] },
  ]);
  assert.equal(JSON.stringify(plans), before);
});

test('missing selling-point labels remain identifiable without inventing a name', () => {
  assert.equal(structureGroupLabel({ coreIds: ['capacity'] }), 'capacity');
  assert.equal(structureGroupLabel({ coreIds: ['one-hand', 'capacity'], coreLabels: { capacity: '500 毫升容量', 'one-hand': '  ' } }), '500 毫升容量＋one-hand');
});

test('opening groups retain all 70 saved IDs and merge later versions by the same source opening', () => {
  const seed: StructurePlan[] = Array.from({ length: 70 }, (_, i) => ({ id: `saved-${i}`, version: 'ai-structure-plans-v4', scope: { sourceId: 's', productId: 'p', intervalId: 'i' }, speed: 1.3, durationMs: 35000, coreIds: ['c'], clips: [{ candidateId: `opening-${i}`, sourceId: 's', startMs: i * 1000, endMs: i * 1000 + 900, text: '同样的标题前缀', roles: ['hook'], coreIds: [] }] }));
  const added = [1, 2].map(i => ({ ...seed[0]!, id: `added-${i}`, version: 'ai-structure-plans-v5' }));
  const plans = [...seed, ...added], before = JSON.stringify(plans), groups = groupStructurePlansByOpening(plans);
  assert.equal(groups.length, 70); assert.equal(groups[0]!.plans.length, 3);
  assert.deepEqual(groups[0]!.plans.map(plan => plan.id), ['saved-0', 'added-1', 'added-2']);
  assert.deepEqual(groups.map(group => group.plans[0]!.id), seed.map(plan => plan.id));
  assert.equal(JSON.stringify(plans), before, 'grouping must never rewrite or renumber saved plans');
});

test('opening grouping keeps different source ranges and lectures apart, including legacy records without candidate IDs', () => {
  const base = { id: 'first', scope: { sourceId: 's', productId: 'p', intervalId: 'i' }, clips: [{ sourceId: 's', startMs: 0, endMs: 900, text: '一样的原话', roles: ['hook'], coreIds: [] }] };
  const plans = [base, { ...base, id: 'same-opening' }, { ...base, id: 'different-range', clips: [{ ...base.clips[0]!, startMs: 1000, endMs: 1900 }] }, { ...base, id: 'different-lecture', scope: { ...base.scope, intervalId: 'j' } }];
  assert.deepEqual(groupStructurePlansByOpening(plans).map(group => group.plans.map(plan => plan.id)), [['first', 'same-opening'], ['different-range'], ['different-lecture']]);
});

test('v5 allows only persisted seed or added IDs while a later batch is unfinished', () => {
  const state = { version: 'ai-structure-plans-v5', status: 'failed', plans: [{ id: 'seed', version: 'ai-structure-plans-v4' }, { id: 'pending', version: 'ai-structure-plans-v5' }], usablePlanIds: ['seed'] } as StructurePlansState;
  assert.equal(isSavedStructurePlanUsable(state, 'seed'), true);
  assert.equal(isSavedStructurePlanUsable(state, 'pending'), false);
  assert.equal(isSavedStructurePlanUsable({ ...state, status: 'unavailable' }, 'seed'), false);
});

test('draft switching flushes debounced settings and waits for writes added during saving', async () => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const unregister = registerDraftFlush('A', () => trackDraftWrite('A', 'style', pending));
  let settled = false;
  const saving = settleDraftWrites('A').then(() => { settled = true; });
  await Promise.resolve(); assert.equal(settled, false);
  finish(); await saving; assert.equal(settled, true); unregister();
});

test('failed saves block switching that draft until that write succeeds, without blocking another draft', async () => {
  await assert.rejects(trackDraftWrite('A', 'settings', Promise.reject(new Error('disk full'))), /disk full/);
  await settleDraftWrites('B');
  await assert.rejects(settleDraftWrites('A'), /disk full/);
  await trackDraftWrite('A', 'settings', Promise.resolve());
  await settleDraftWrites('A');
});

test('a debounced flush failure clearly says changes are unsaved and can be retried', async () => {
  let fail = true;
  const remove = registerDraftFlush('flush-failure', async () => { if (fail) throw new Error('503'); });
  await assert.rejects(settleDraftWrites('flush-failure'), /修改未保存.*503/);
  fail = false; await settleDraftWrites('flush-failure'); remove();
});
