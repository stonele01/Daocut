import { sourceTime } from './product-analysis.ts';

export interface ProductVisualReview {
  version: 'product-visual-review-v1'; status: 'complete' | 'unavailable' | 'uncertain' | 'failed';
  key?: string; candidatesHash?: string; productName?: string; scope: { startMs: number; endMs: number };
  model?: { name?: string; model?: string; provider?: string; endpoint?: string };
  entries: { startMs: number; endMs: number; cueRange?: [number, number]; productMatch: 'match' | 'mismatch' | 'uncertain'; display: 'shown' | 'not-shown' | 'uncertain'; evidenceTimesMs: number[]; observation: string; issues: string[] }[];
  issues: string[]; continuousActionVerified: false; speechVerified: false;
}

export interface ProductVisualPlan {
  identity: string; scope: { sourceId: string; productId: string; intervalId: string; startMs: number; endMs: number };
  service: { enabled: boolean; name?: string; model?: string; provider?: string; endpoint?: string; error?: string };
  enabled: boolean; requestCount: number; maxImages: number; cached: boolean; recoverable?: boolean; retryRequired: boolean; error?: string;
}

export function visualReviewCanSubmit(plan: ProductVisualPlan | null | undefined, retryAcknowledged: boolean) {
  return !!plan && !plan.error && (plan.enabled || plan.cached || plan.recoverable === true) && (!plan.retryRequired || retryAcknowledged);
}

/** Render persisted semantic evidence only. This function never calls a tool/model. */
export function visualReviewPresentation(review: ProductVisualReview | null | undefined, origin: 'shared' | 'local' | 'saved' = 'shared', stale = false) {
  if (!review) return { summary: 'AI 看图：未保存记录', originLabel: '', range: '', productName: '', note: '沿用已有话术，未自动发送画面给模型。', entries: [] as { range: string; product: string; display: string; evidence: string; observation: string; issues: string[] }[], issues: [] as string[] };
  return {
    summary: stale ? 'AI 看图旧记录需核对' : { complete: 'AI 看图结果已保存', uncertain: 'AI 看图结果需核对', failed: 'AI 看图请求未完成', unavailable: 'AI 看图暂不可用' }[review.status],
    originLabel: origin === 'local' ? '本机 AI 看图补查记录，未改公共底稿' : origin === 'saved' ? '当前工程已保存的 AI 看图记录' : '复用公共 AI 看图记录',
    range: `${sourceTime(review.scope.startMs)}–${sourceTime(review.scope.endMs)}`,
    productName: review.productName ? `核查时商品：${review.productName}` : '',
    note: `${stale ? '商品名称/话术范围已变，以下为旧记录需核对。' : ''}仅判断抽帧中的商品和展示内容；连续动作未核实，原音未核听。`,
    entries: review.entries.map(entry => ({
      range: `${sourceTime(entry.startMs)}–${sourceTime(entry.endMs)}`,
      product: `${stale ? '旧记录' : ''}商品对应：${{ match: '匹配', mismatch: '不匹配', uncertain: '不确定' }[entry.productMatch]}`,
      display: `产品展示：${{ shown: '画面可见', 'not-shown': '抽帧未见', uncertain: '不确定' }[entry.display]}`,
      evidence: `证据时刻：${entry.evidenceTimesMs.length ? entry.evidenceTimesMs.map(sourceTime).join('、') : '未提供'}`,
      observation: entry.observation, issues: entry.issues,
    })),
    issues: review.issues,
  };
}
