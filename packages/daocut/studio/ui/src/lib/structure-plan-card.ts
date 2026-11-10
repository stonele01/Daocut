import { structureRole, type StructurePlan } from './structure-workspace.ts';

const roleShort: Record<string, string> = { hook: '钩子', story: '故事', display: '展示', pain: '痛点', core: '卖点', offer: '福利', trust: '背书', purchase: '逼单', context: '前文' };
const roleColor: Record<string, string> = { hook: '#ba8543', story: '#ba8543', display: '#0e7490', pain: '#d58a50', core: '#9d79d8', offer: '#6b99dc', trust: '#6b99dc', purchase: '#69b39c', context: '#9ca3af' };

export function planLetter(index: number): string {
  let number = index + 1, label = '';
  while (number > 0) { number -= 1; label = String.fromCharCode(65 + number % 26) + label; number = Math.floor(number / 26); }
  return label;
}

/** Draft directories may sort differently as copies are added; their public-plan identity does not change. */
export function structureDraftLabel(planId: string, plans: readonly ({ id: string } & Partial<StructurePlan>)[]): string {
  const index = plans.findIndex(plan => plan.id === planId);
  const plan = plans[index];
  if (plan?.clips && plan.coreIds && typeof plan.durationMs === 'number') {
    const card = structurePlanCard({ clips: plan.clips, coreIds: plan.coreIds, coreLabels: plan.coreLabels, durationMs: plan.durationMs });
    // This is the public plan's duration; personal trimming may have changed the draft's length.
    return `方案 ${planLetter(index)} · ${card.title} · 原方案${card.durationLabel.replace(' 秒', '秒')}`;
  }
  return index >= 0 ? `方案 ${planLetter(index)} 的副本` : `个人副本 · ${planId.slice(-6)}`;
}

function excerpt(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  const sentence = clean.match(/^[^。！？!?]*[。！？!?]/u)?.[0] ?? clean;
  const chars = Array.from(sentence);
  return chars.length > 14 ? `${chars.slice(0, 14).join('')}…` : sentence;
}

/** Display labels describe confirmed selling points and source order, never new marketing copy. */
export function structurePlanCard(plan: Pick<StructurePlan, 'clips' | 'coreIds' | 'coreLabels' | 'durationMs'>) {
  const coreIds = [...new Set(plan.coreIds)];
  const labels = coreIds.flatMap(id => plan.coreLabels?.[id] ? [plan.coreLabels[id]!] : []);
  const hook = plan.clips.find(clip => clip.roles.includes('hook'));
  const coreClips = plan.clips.filter(clip => clip.roles.includes('core'));
  const coreSequence: { key: string; label: string; count: number }[] = [];
  for (const clip of coreClips) {
    const ids = [...new Set(clip.coreIds)].sort(), key = ids.join('\u0000');
    const label = ids.map(id => plan.coreLabels?.[id] || `卖点 ${id}`).join('＋') || '卖点待核对';
    const previous = coreSequence.at(-1);
    if (previous?.key === key) previous.count += 1;
    else coreSequence.push({ key, label, count: 1 });
  }
  const blocks = plan.clips.map(clip => ({
    roles: clip.roles, label: clip.roles.map(role => roleShort[role] ?? role).join('/'),
    fullLabel: clip.roles.map(structureRole).join('/'), durationMs: clip.endMs - clip.startMs,
    color: roleColor[clip.roles.find(role => role !== 'context') ?? 'context'] ?? '#9ca3af',
  }));
  const middle: { label: string; count: number }[] = [];
  for (const block of blocks.slice(1, -1)) {
    const previous = middle.at(-1);
    if (previous?.label === block.fullLabel) previous.count += 1;
    else middle.push({ label: block.fullLabel, count: 1 });
  }
  const summary = blocks.length ? [
    `${blocks[0]!.fullLabel}开场`,
    ...(middle.length ? [`串联${middle.map(item => `${item.count}段${item.label}`).join('、')}`] : []),
    ...(blocks.length > 1 ? [`${blocks.at(-1)!.fullLabel}收尾`] : []),
  ].join('，') : '';
  const seconds = plan.durationMs / 1000;
  return {
    title: coreSequence.length ? coreSequence.map(item => `${item.label}${item.count > 1 ? `（${item.count}段）` : ''}`).join(' → ') : labels.join('＋') || '结构方案',
    subtitle: coreClips.length ? `卖点原话：${coreClips.map(clip => excerpt(clip.text)).join(' → ')}` : '卖点原话待核对',
    fullCoreQuotes: coreClips.map(clip => clip.text).join(' → '),
    hook: hook?.text.trim() ? `钩子：${excerpt(hook.text)}` : '钩子原话待核对',
    fullHook: hook?.text ?? '',
    blocks, summary, coreCount: coreIds.length,
    durationLabel: `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} 秒`,
    durationHint: seconds < 30 ? '不足30秒 · 可用' : seconds > 50 ? '超过50秒 · 可用' : '参考时长内',
  };
}
