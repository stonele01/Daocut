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

test('compact cards lead with the real opening and retain selling-point quotes without inventing claims', () => {
  const before = JSON.stringify(plan), card = structurePlanCard(plan);
  assert.equal(card.title, '开头｜拿杯子总要拧半天');
  assert.equal(card.subtitle, '卖点原话：这个杯子是五百毫升的。 → 杯盖可以单手按压打开。');
  assert.equal(card.hook, '开头原话：拿杯子总要拧半天？');
  assert.equal(card.coreCount, 2);
  assert.equal(card.durationLabel, '54 秒');
  assert.equal(card.durationHint, '超过50秒 · 可用');
  assert.equal(card.summary, '钩子开场，串联2段卖点，购买逼单收尾');
  assert.equal(JSON.stringify(plan), before);
});

test('1.3x cards show accelerated subclip durations and the 30–40 second rule without changing quotes', () => {
  const accelerated = { ...plan, version: 'ai-structure-plans-v2', speed: 1.3 as const, durationMs: 39000,
    clips: plan.clips.map((clip, index) => ({ ...clip, endMs: index === 3 ? clip.endMs - 3300 : clip.endMs, speed: 1.3 as const })) };
  const before = JSON.stringify(accelerated), card = structurePlanCard(accelerated);
  assert.equal(card.speedLabel, '1.3 倍速');
  assert.equal(card.durationLabel, '39 秒');
  assert.equal(card.durationHint, '30～40秒内');
  assert.equal(card.durationInRange, true);
  assert.deepEqual(card.blocks.map(block => block.durationMs), accelerated.clips.map(clip => (clip.endMs - clip.startMs) / 1.3));
  assert.equal(card.fullCoreQuotes, structurePlanCard(plan).fullCoreQuotes);
  assert.equal(JSON.stringify(accelerated), before);
  assert.equal(structurePlanCard({ ...accelerated, durationMs: 41000 }).durationHint, '超过40秒');
  assert.equal(structurePlanCard({ ...accelerated, durationMs: 29000 }).durationHint, '不足30秒');
  assert.equal(structurePlanCard({ ...accelerated, durationMs: 41000 }).durationInRange, false);
  assert.equal(structurePlanCard(plan).speedLabel, '原速');
  assert.equal(structurePlanCard({ ...plan, durationMs: 42000 }).durationHint, '参考时长内');
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
  assert.equal(structurePlanCard({ ...plan, clips: [] }).title, '开头待核对');
  assert.equal(structurePlanCard({ ...plan, clips: [], coreLabels: undefined }).title, '开头待核对');
});

test('same hook remains distinguishable by selling-point order and exact wording, without changing plan data', () => {
  const reversed = { ...plan, clips: [plan.clips[0]!, plan.clips[2]!, plan.clips[1]!, plan.clips[3]!] };
  assert.equal(structurePlanCard(reversed).title, structurePlanCard(plan).title);
  assert.notEqual(structurePlanCard(reversed).subtitle, structurePlanCard(plan).subtitle);
  const first = { ...plan, coreIds: ['capacity'], clips: [plan.clips[0]!, plan.clips[1]!, plan.clips[3]!] };
  const other = { ...first, clips: [plan.clips[0]!, { ...plan.clips[1]!, text: '五百毫升容量，通勤路上喝水够用。' }, plan.clips[3]!] };
  const before = JSON.stringify([first, other]);
  assert.equal(structurePlanCard(first).title, '开头｜拿杯子总要拧半天');
  assert.equal(structurePlanCard(other).title, '开头｜拿杯子总要拧半天');
  assert.notEqual(structurePlanCard(first).subtitle, structurePlanCard(other).subtitle);
  assert.equal(JSON.stringify([first, other]), before);
  const repeated = { ...first, clips: [first.clips[0]!, first.clips[1]!, other.clips[1]!, first.clips[2]!] };
  assert.equal(structurePlanCard(repeated).title, structurePlanCard(first).title);
  assert.notEqual(structurePlanCard(repeated).subtitle, structurePlanCard(first).subtitle);
  assert.equal(structurePlanCard(repeated).coreCount, 1);
});

test('draft selector labels show content and duration while preserving the stable plan reference', () => {
  const before = JSON.stringify(plan);
  assert.equal(structureDraftLabel(plan.id, [plan]), '方案 A · 开头｜拿杯子总要拧半天 · 原方案54秒');
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

test('opening titles use the first clip even without a hook tag and skip generic greetings', () => {
  const actual = { ...plan, clips: [
    { ...plan.clips[0]!, text: '哪些人去用？姐妹们，你们有没有那种脸？干，干纹细纹很严重，一做表情全是皱皱巴巴的这种的脸。', roles: ['pain'] },
    { ...plan.clips[1]!, text: '后面这一句才有钩子标签。', roles: ['hook', 'core'] },
    ...plan.clips.slice(2),
  ] };
  const before = JSON.stringify(actual), card = structurePlanCard(actual);
  assert.equal(card.title, '痛点共鸣｜干纹细纹很严重');
  assert.equal(card.fullHook, actual.clips[0]!.text);
  assert.ok(!card.title.includes('后面'));
  assert.equal(JSON.stringify(actual), before);
});

test('prices need an actual comparison cue, and nearby purchase qualifications remain visible', () => {
  const cardFor = (text: string) => structurePlanCard({ ...plan, clips: [{ ...plan.clips[0]!, text, roles: ['offer', 'hook'] }, ...plan.clips.slice(1)] });
  assert.equal(cardFor('别人卖198块，今天59块两瓶。').title, '价格对比｜别人卖198块');
  assert.equal(cardFor('59块两瓶。').title, '价格福利｜59块两瓶');
  assert.equal(cardFor('领券后，59元两瓶。').title, '价格福利｜领券后，59元两瓶');
  assert.equal(cardFor('会员专享，59元两瓶。').title, '价格福利｜会员专享，59元两瓶');
});

test('usage, story and short openings stay readable and are computed for old plan versions too', () => {
  const cardFor = (text: string, roles: string[], version = 'ai-structure-plans-v1') => structurePlanCard({ ...plan, version,
    clips: [{ ...plan.clips[0]!, text, roles }, ...plan.clips.slice(1)] });
  assert.equal(cardFor('怎么用？姐妹们，非常好用，非常简单。洗完脸先用水，第二步摇一摇它。', ['hook', 'core']).title, '使用方法｜洗完脸先用水');
  assert.equal(cardFor('我第一次带孩子露营，赶上了大雨。', ['story']).title, '故事经历｜我第一次带孩子露营');
  assert.equal(cardFor('省时间。', ['core'], 'ai-structure-plans-v3').title, '卖点切入｜省时间');
  assert.equal(cardFor('别买错。', ['hook']).title, '开头｜别买错');
  assert.equal(cardFor(' ', ['hook']).title, '开头待核对');
});
