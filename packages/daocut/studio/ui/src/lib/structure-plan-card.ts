import { previewClipDuration, structureRole, structureSpeedLabel, type StructurePlan } from './structure-workspace.ts';

const roleShort: Record<string, string> = { hook: '钩子', story: '故事', intro: '介绍', display: '展示', pain: '痛点', core: '卖点', offer: '福利', trust: '背书', purchase: '逼单', context: '前文' };
const roleColor: Record<string, string> = { hook: '#ba8543', story: '#ba8543', intro: '#0e7490', display: '#0e7490', pain: '#d58a50', core: '#9d79d8', offer: '#6b99dc', trust: '#6b99dc', purchase: '#69b39c', context: '#9ca3af' };

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
    const card = structurePlanCard({ clips: plan.clips, coreIds: plan.coreIds, coreLabels: plan.coreLabels, durationMs: plan.durationMs, speed: plan.speed, version: plan.version });
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

function openingType(roles: readonly string[], text: string): string {
  if (roles.includes('offer')) {
    // A price or a number alone is not evidence of a comparison.
    const price = /\d|[一二两三四五六七八九十百千万]+(?:元|块)|(?:卖|价格|只要).{0,6}[一二两三四五六七八九十百千万]/u.test(text);
    const comparison = /原价|全网比|价格对比|对比价格|平时.{0,12}(?:卖|价格|块|元)|(?:别人|人家|他们|外面|模仿).{0,18}(?:卖|价格|块|元)|(?:单买|单独买).{0,18}(?:套组|套装|一起买)|比.{0,12}(?:贵|便宜)/u.test(text);
    return price && comparison ? '价格对比' : '价格福利';
  }
  if (roles.includes('pain')) return '痛点共鸣';
  if (roles.includes('story')) return '故事经历';
  if (/怎么用|如何使用|怎么使用|使用方法|用法/u.test(text.slice(0, 48))) return '使用方法';
  if (roles.includes('intro')) return '产品介绍开头';
  if (roles.includes('display')) return '展示开头';
  if (roles.includes('core')) return '卖点切入';
  if (roles.includes('trust')) return '信任背书';
  return '开头';
}

/** Pick a short source excerpt, not a newly written promise or a title from the body. */
function openingExcerpt(text: string, type: string): string {
  const parts = text.replace(/\s+/g, ' ').trim().split(/[，,。！？!?；;：:]+/u)
    .map(part => part.trim())
    .filter(part => part && !/^(?:(?:姐妹们?|家人们|朋友们|老铁们?|大家)[呀啊哈]?|我要问问你|我问你|我跟你说|你看[呀啊哈]?|(?:姐妹)?给你看一下[呀啊哈]?|给大家看|听我说|哪些人去用|什么人用|怎么用[呀啊哈]?|如何使用|这种的有没有这种的|有|对|是的|嗯|好|羡慕|我的天|非常简单|非常好用)$/u.test(part))
    .filter(part => !/^(?:你们?(?:有(?:没有)?|羡慕|想要|还是想要|说你是想要).*[这那](?:种|个|样).{0,8}|羡慕[这那]种.{0,4}|肯定想要刚才[这那]种|你看[这那]种.{0,3}|(?:老铁)?你知道我什么情况[哈吗]?|我们?这个.{0,6}很(?:好|棒)[呀啊哈]?)$/u.test(part));
  if (!parts.length) return excerpt(text).replace(/[。！？!?]$/u, '');
  let index = 0;
  if (type === '价格对比' || type === '价格福利') {
    const priced = parts.findIndex(part => /(?:\d+(?:\.\d+)?|[一二两三四五六七八九十百千万]+)(?:元|块)|(?:卖|价|到手|买|送|只要).{0,6}(?:\d|[一二两三四五六七八九十百千万])/u.test(part));
    if (priced >= 0) {
      index = priced;
      // Keep an adjacent qualification instead of turning a conditional price into a promise.
      if (index > 0 && /领券|会员|满.{0,6}减|限.{0,6}(?:人|件|单)|如果|仅限/u.test(parts[index - 1]!)) index -= 1;
    }
  }
  let selected = parts[index]!;
  if (selected.length <= 3 && parts[index + 1]) {
    selected = parts[index + 1]!.startsWith(selected) ? parts[index + 1]! : `${selected}，${parts[index + 1]}`;
  } else if (/领券|会员|满.{0,6}减|限.{0,6}(?:人|件|单)|如果|仅限/u.test(selected) && parts[index + 1] && !/\d/u.test(selected)) {
    selected += `，${parts[index + 1]}`;
  }
  const chars = Array.from(selected);
  return chars.length > 22 ? `${chars.slice(0, 22).join('')}…` : selected;
}

/** The title describes the actual first played clip; the subtitle distinguishes its selling-point body. */
export function structurePlanCard(plan: Pick<StructurePlan, 'clips' | 'coreIds' | 'coreLabels' | 'durationMs'> & Partial<Pick<StructurePlan, 'speed' | 'version'>>) {
  const coreIds = [...new Set(plan.coreIds)];
  const opening = plan.clips[0];
  const type = opening ? openingType(opening.roles, opening.text) : '';
  const openingLabel = opening?.text.trim() ? openingExcerpt(opening.text, type) : '';
  const coreClips = plan.clips.filter(clip => clip.roles.includes('core'));
  const blocks = plan.clips.map(clip => ({
    roles: clip.roles, label: clip.roles.map(role => roleShort[role] ?? role).join('/'),
    fullLabel: clip.roles.map(structureRole).join('/'), durationMs: previewClipDuration(plan, clip),
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
  const accelerated = plan.speed === 1.3;
  return {
    openingType: type,
    title: openingLabel ? `${type}｜${openingLabel}` : '开头待核对',
    subtitle: coreClips.length ? `卖点原话：${coreClips.map(clip => excerpt(clip.text)).join(' → ')}` : '卖点原话待核对',
    fullCoreQuotes: coreClips.map(clip => clip.text).join(' → '),
    hook: opening?.text.trim() ? `开头原话：${excerpt(opening.text)}` : '开头原话待核对',
    fullHook: opening?.text ?? '',
    blocks, summary, coreCount: coreIds.length, speedLabel: structureSpeedLabel(plan),
    durationInRange: seconds >= 30 && seconds <= (accelerated ? 40 : 50),
    durationLabel: `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} 秒`,
    durationHint: accelerated
      ? seconds < 30 ? '不足30秒' : seconds > 40 ? '超过40秒' : '30～40秒内'
      : seconds < 30 ? '不足30秒 · 可用' : seconds > 50 ? '超过50秒 · 可用' : '参考时长内',
  };
}
