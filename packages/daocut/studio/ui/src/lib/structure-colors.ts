import { displayStructureTag } from './product-structure-tags.ts';

/** Shared structure colors use distinct saturated backgrounds with white text in both themes. */
const colors: Record<string, { bg: string; text: string; border: string }> = {
  '钩子': { bg: '#2563eb', text: '#ffffff', border: '#60a5fa' },
  '故事': { bg: '#a16207', text: '#ffffff', border: '#facc15' },
  '痛点': { bg: '#c2410c', text: '#ffffff', border: '#fb923c' },
  '卖点': { bg: '#15803d', text: '#ffffff', border: '#4ade80' },
  '产品演示': { bg: '#0e7490', text: '#ffffff', border: '#22d3ee' },
  '福利机制': { bg: '#7e22ce', text: '#ffffff', border: '#c084fc' },
  '信任背书': { bg: '#4338ca', text: '#ffffff', border: '#a5b4fc' },
  '逼单': { bg: '#be123c', text: '#ffffff', border: '#fb7185' },
};
const fallback = { bg: '#475569', text: '#ffffff', border: '#94a3b8' };

export function structureColor(tag: string) {
  return colors[displayStructureTag(tag)] ?? fallback;
}

/** Hard stops preserve each tag's color without implying a blended category. */
export function structureGradient(tags: readonly string[]) {
  const entries = tags.length ? tags : [''];
  return `linear-gradient(90deg, ${entries.map((tag, index) => {
    const color = structureColor(tag).bg;
    return `${color} ${index / entries.length * 100}%, ${color} ${(index + 1) / entries.length * 100}%`;
  }).join(', ')})`;
}
