import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupStructurePlans, previewPosition, structureGroupLabel } from './structure-workspace.ts';
import { registerDraftFlush, settleDraftWrites, trackDraftWrite } from './draft-save-barrier.ts';

test('preview clock follows a discontiguous source sequence without changing a plan or editor', () => {
  const plan = { clips: [{ startMs: 20000, endMs: 24000 }, { startMs: 1000, endMs: 6000 }] };
  const original = JSON.stringify(plan);
  assert.deepEqual(previewPosition(plan, 4500), { index: 1, sourceMs: 1500, offsetMs: 4000 });
  assert.deepEqual(previewPosition(plan, 9000), { index: 1, sourceMs: 6000, offsetMs: 4000 });
  assert.equal(JSON.stringify(plan), original);
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
