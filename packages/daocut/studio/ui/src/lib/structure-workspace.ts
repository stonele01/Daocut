import type { ProductMediaReview } from './product-media-review';
import type { ProductVisualReview } from './product-visual-review';

export interface StructureScope { sourceId: string; productId: string; intervalId: string; startMs?: number; endMs?: number }
export interface StructurePlan {
  id: string; version?: string | number; scope: StructureScope; durationMs: number; speed: 1; coreIds: string[];
  coreLabels?: Record<string, string>; referenceDuration?: string;
  clips: { sourceId: string; assetPath?: string; startMs: number; endMs: number; text: string; roles: string[]; coreIds: string[] }[];
}
export interface StructurePlansState {
  status: 'idle' | 'running' | 'complete' | 'publish-pending' | 'busy' | 'unavailable';
  taskKey?: string; plans: StructurePlan[]; complete?: boolean; materialComplete?: boolean; allValidCombinationsEnumerated?: boolean;
  issues?: { code: string; message: string; candidateId?: string; text?: string; startMs?: number; endMs?: number }[]; stats?: Record<string, number>;
  context?: StructureScope & { visibility: string }; requestCount?: number;
  mediaReview?: ProductMediaReview;
  mediaReviewOrigin?: 'shared' | 'local';
  visualReview?: ProductVisualReview;
  visualReviewOrigin?: 'shared' | 'local';
  visualReviewStale?: boolean;
}
export interface StructureDraft { projectId: string; planId: string; planVersion: string | number; scope: StructureScope; durationMs: number }
export interface StructureWorkspaceState { ownerId: string; activeProjectId: string; drafts: StructureDraft[] }

/** Group by selling-point identity only. Every distinct playable sequence remains available. */
export function groupStructurePlans<T extends { id: string; coreIds: string[] }>(plans: readonly T[]): { key: string; plans: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const plan of plans) { const key = [...plan.coreIds].sort().join('\u0000'); const rows = groups.get(key) ?? []; rows.push(plan); groups.set(key, rows); }
  return [...groups].map(([key, rows]) => ({ key, plans: rows }));
}
export function structureGroupLabel(plan: Pick<StructurePlan, 'coreIds' | 'coreLabels'>): string {
  return [...plan.coreIds].sort().map(id => plan.coreLabels?.[id]?.trim() || id).join('＋');
}
export function previewPosition(plan: { clips: { startMs: number; endMs: number }[] }, timeMs: number) {
  let offsetMs = 0;
  for (let index = 0; index < plan.clips.length; index += 1) {
    const clip = plan.clips[index]!, duration = clip.endMs - clip.startMs;
    if (timeMs < offsetMs + duration || index === plan.clips.length - 1) return { index, sourceMs: clip.startMs + Math.max(0, Math.min(duration, timeMs - offsetMs)), offsetMs };
    offsetMs += duration;
  }
  return { index: 0, sourceMs: 0, offsetMs: 0 };
}
export const structureRole = (role: string) => ({ hook: '钩子', story: '故事', display: '产品展示', core: '卖点', purchase: '购买逼单', pain: '痛点', offer: '福利机制', trust: '信任背书', context: '必要上下文' }[role] ?? role);
