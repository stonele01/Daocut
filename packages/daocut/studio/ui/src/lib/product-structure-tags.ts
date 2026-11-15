/** Presentation aliases only: saved public candidates keep their original labels. */
const aliases: Record<string, string> = { '价格锚点': '福利机制', '行动指令': '逼单' };

export const productStructureTags: readonly string[] = ['钩子', '故事', '痛点', '卖点', '产品介绍', '价格机制', '福利机制', '信任背书', '逼单'];

export const displayStructureTag = (tag: string): string => aliases[tag] ?? tag;

export const displayStructureTags = (tags: readonly string[]): string[] => [...new Set(tags.map(displayStructureTag))];

export function hasStructureTag(tags: readonly string[], selected: string): boolean {
  return selected === '全部' || tags.some(tag => displayStructureTag(tag) === displayStructureTag(selected));
}
