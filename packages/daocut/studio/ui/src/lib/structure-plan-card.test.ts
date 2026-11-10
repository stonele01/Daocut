import { test } from 'node:test';
import assert from 'node:assert/strict';
import { structurePlanCard, planLetter, structureDraftLabel } from './structure-plan-card.ts';
import type { StructurePlan } from './structure-workspace.ts';

const plan: StructurePlan = {
  id: 'local-plan', speed: 1, durationMs: 54000, coreIds: ['capacity', 'lid'],
  coreLabels: { capacity: '500毫升容量', lid: '单手按压开盖' },
  scope: { sourceId: 's', productId: 'p', intervalId: 'lecture-1' },
  clips: [
    { sourceId: 's', startMs: 20000, endMs: 28000, text: '拿杯子总要拧半天？这款杯子一按就能打开。', roles: ['hook'], coreIds: [] },
    { sourceId: 's', startMs: 30000, endMs: 48000, text: '这个杯子是五百毫升的。', roles: ['core'], coreIds: ['capacity'] },
    { sourceId: 's', startMs: 50000, endMs: 70000, text: '杯盖可以单手按压打开。', roles: ['core'], coreIds: ['lid'] },
    { sourceId: 's', startMs: 80000, endMs: 88000, text: '确认规格后点击商品链接购买。', roles: ['purchase'], coreIds: [] },
  ],
};

test('compact card text distinguishes selling points and retains source quotes without inventing marketing claims', () => {
  const before = JSON.stringify(plan), card = structurePlanCard(plan);
  assert.equal(card.title, '500毫升容量 → 单手按压开盖');
  assert.equal(card.subtitle, '卖点原话：这个杯子是五百毫升的。 → 杯盖可以单手按压打开。');
  assert.equal(card.hook, '钩子：拿杯子总要拧半天？');
  assert.equal(card.coreCount, 2);
  assert.equal(card.durationLabel, '54 秒');
  assert.equal(card.durationHint, '超过50秒 · 可用');
  assert.equal(card.summary, '钩子开场，串联2段卖点，购买逼单收尾');
  assert.equal(JSON.stringify(plan), before);
});

test('structure blocks preserve every real clip and original order, including context and optional roles', () => {
  const mixed = { ...plan, clips: [{ ...plan.clips[0]!, roles: ['context', 'hook'] }, ...plan.clips.slice(1), { ...plan.clips[0]!, roles: ['trust'] }] };
  const card = structurePlanCard(mixed);
  assert.equal(card.blocks.length, mixed.clips.length);
  assert.deepEqual(card.blocks.map(block => block.roles), [['context', 'hook'], ['core'], ['core'], ['purchase'], ['trust']]);
  assert.deepEqual(card.blocks.map(block => block.durationMs), [8000, 18000, 20000, 8000, 8000]);
  assert.equal(card.blocks[0]!.label, '前文/钩子');
  assert.equal(card.blocks[4]!.label, '背书');
});

test('letters remain distinct after Z and duration hints do not reject short or long valid plans', () => {
  assert.deepEqual([0, 1, 25, 26, 27, 701, 702].map(planLetter), ['A', 'B', 'Z', 'AA', 'AB', 'ZZ', 'AAA']);
  assert.equal(structurePlanCard({ ...plan, durationMs: 29000 }).durationHint, '不足30秒 · 可用');
  assert.equal(structurePlanCard({ ...plan, durationMs: 42000 }).durationHint, '参考时长内');
  assert.equal(structurePlanCard({ ...plan, clips: [] }).title, '500毫升容量＋单手按压开盖');
  assert.equal(structurePlanCard({ ...plan, clips: [], coreLabels: undefined }).title, '结构方案');
});

test('same hook remains distinguishable by selling-point order and exact wording, without changing plan data', () => {
  const reversed = { ...plan, clips: [plan.clips[0]!, plan.clips[2]!, plan.clips[1]!, plan.clips[3]!] };
  assert.equal(structurePlanCard(reversed).title, '单手按压开盖 → 500毫升容量');
  const first = { ...plan, coreIds: ['capacity'], clips: [plan.clips[0]!, plan.clips[1]!, plan.clips[3]!] };
  const other = { ...first, clips: [plan.clips[0]!, { ...plan.clips[1]!, text: '五百毫升容量，通勤路上喝水够用。' }, plan.clips[3]!] };
  const before = JSON.stringify([first, other]);
  assert.equal(structurePlanCard(first).title, '500毫升容量');
  assert.equal(structurePlanCard(other).title, '500毫升容量');
  assert.notEqual(structurePlanCard(first).subtitle, structurePlanCard(other).subtitle);
  assert.equal(JSON.stringify([first, other]), before);
  const repeated = { ...first, clips: [first.clips[0]!, first.clips[1]!, other.clips[1]!, first.clips[2]!] };
  assert.equal(structurePlanCard(repeated).title, '500毫升容量（2段）');
  assert.equal(structurePlanCard(repeated).coreCount, 1);
});

test('draft selector labels show content and duration while preserving the stable plan reference', () => {
  const before = JSON.stringify(plan);
  assert.equal(structureDraftLabel(plan.id, [plan]), '方案 A · 500毫升容量 → 单手按压开盖 · 原方案54秒');
  assert.equal(JSON.stringify(plan), before);
});

test('private copy labels follow their public plan instead of the current draft directory ordering', () => {
  const plans = [{ id: 'plan-a-111111' }, { id: 'plan-b-222222' }];
  const before = ['plan-a-111111'].map(id => structureDraftLabel(id, plans));
  const after = ['plan-b-222222', 'plan-a-111111'].map(id => structureDraftLabel(id, plans));
  assert.equal(before[0], '方案 A 的副本');
  assert.deepEqual(after, ['方案 B 的副本', '方案 A 的副本']);
  assert.equal(structureDraftLabel('other-lecture-333333', plans), '个人副本 · 333333');
  assert.equal(structureDraftLabel('plan-a-111111', []), '个人副本 · 111111');
});

test('story and display roles retain readable block labels without turning body content into hooks', () => {
  const mixed = { ...plan, clips: [
    { ...plan.clips[0]!, roles: ['hook', 'story'] },
    { ...plan.clips[1]!, roles: ['core', 'display'] },
    { ...plan.clips[2]!, roles: ['offer', 'trust'], coreIds: [] },
    plan.clips[3]!,
  ] };
  const before = JSON.stringify(mixed), card = structurePlanCard(mixed);
  assert.equal(card.blocks[0]!.label, '钩子/故事');
  assert.equal(card.blocks[0]!.fullLabel, '钩子/故事');
  assert.equal(card.blocks[1]!.label, '卖点/展示');
  assert.equal(card.blocks[1]!.fullLabel, '卖点/产品展示');
  assert.equal(card.blocks[2]!.fullLabel, '福利机制/信任背书');
  assert.ok(!card.blocks[1]!.roles.includes('hook'));
  assert.equal(card.fullHook, mixed.clips[0]!.text);
  assert.equal(JSON.stringify(mixed), before);
});
