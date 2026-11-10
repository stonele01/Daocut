import type { StudioProductRange } from 'daocut/studio-ui/lib/host.ts';
import type { ProductWorkflowPlan } from 'daocut/studio-ui/lib/product-workflow-types.ts';

export type StructureIntent = { retry: boolean; rerun: boolean };
export interface ProductStructureTaskState {
  scope: StudioProductRange;
  workflowPlan?: ProductWorkflowPlan;
  analysisPlan?: { enabled: boolean; model: string | null; requestCount: number | null; transcriptSegments: number | null; inputIdentity?: string | null; error?: string; endpoint?: string; costBasis?: string };
  analysis: {
    status: 'idle' | 'running' | 'complete' | 'failed';
    stale?: boolean;
    error?: string;
    currentRunId?: string;
    candidateCount?: number;
    omittedBoundaryWords?: number;
    progress?: { completedWindows: number; totalWindows: number };
  };
}

/** A request not to invoke analysis must not fall through to a paid ordinary chat request either. */
export function productStructureBlocker(text: string): string | null {
  const request = text.trim();
  if (!/(?:结构|分析|识别|模型|请求|话术|钩子|痛点|卖点|福利|逼单|价格锚点|行动指令)/.test(request)) return null;
  if (/(?:不(?:想|要|用|必|需要)?|禁止|暂停|取消|停止|暂缓|无需).{0,12}(?:分析|识别|生成|结构|提取|梳理|整理|拆解|拆分|标注|重试)|(?:^|请|先|[，。！？\s])别.{0,12}(?:分析|识别|生成|结构|提取|梳理|整理|拆解|拆分|标注)/.test(request)
    || /(?:不|别|勿|禁止|无需).{0,18}(?:真实|模型|请求|调用|付费|计费|联网|上传)|(?:仅|只).{0,8}(?:演示|模拟|本地)|mock|dry[ -]?run/i.test(request)) return '这条消息要求暂不发起分析或真实请求，已留在本地，未发送模型。';
  return null;
}

/** Deliberate task commands use the card's task, while questions keep their ordinary chat meaning. */
export function productStructureIntent(text: string): StructureIntent | null {
  const request = text.trim();
  if (productStructureBlocker(request) || /(?:是什么|为什么|什么意思|怎么|如何|能否|是否|要不要|多少钱|费用|解释|讨论|介绍|代码|方案|计划|功能|设计|实现|开发|测试|提示词)/.test(request)) return null;
  const labeledTask = /(?:分析|识别|生成|提取|梳理|整理|输出|拆解|拆分|标注|出|重试).{0,28}(?:结构|话术|钩子|痛点|卖点|福利|逼单|价格锚点|行动指令)|(?:结构|话术|钩子|痛点|卖点|福利|逼单|价格锚点|行动指令).{0,12}(?:分析|识别|生成|提取|梳理|整理|拆解|拆分|标注|重试)/.test(request);
  const selectedRangeTask = /(?:分析|识别)(?:一下|下)?(?:这段|本段|当前商品段|当前段|选中的商品段|所选商品段)(?:吧|一下|谢谢|[。！\s])*$/.test(request);
  if (!labeledTask && !selectedRangeTask) return null;
  return { retry: /重试/.test(request), rerun: /重新.{0,12}(?:分析|识别|生成|结构)|再(?:分析|识别|生成)/.test(request) };
}

export interface ProductStructureTaskIO {
  read(): Promise<ProductStructureTaskState>;
  confirm(state: ProductStructureTaskState): Promise<boolean>;
  start(options: { retryFailed: boolean; rerun: boolean; expectedInputIdentity?: string; plan?: ProductWorkflowPlan }): Promise<ProductStructureTaskState>;
  refresh(): void;
}

function checkScope(state: ProductStructureTaskState, scope: StudioProductRange) {
  if (!state.scope || !['sourceId', 'productId', 'intervalId', 'startMs', 'endMs'].every(key => state.scope[key as keyof StudioProductRange] === scope[key as keyof StudioProductRange])) throw new Error('商品段已经改变，请重新选择后再分析。');
}

function checkStopped(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('已停止等待。已经提交的结构任务仍可在商品卡片查看，不会自动重发。');
}

const delay = (signal?: AbortSignal) => new Promise<void>(resolve => {
  const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, 800);
  signal?.addEventListener('abort', done, { once: true });
});

/** No model session, transcript upload, ASR or automatic retry lives in this path. */
export async function runProductStructureTask(io: ProductStructureTaskIO, scope: StudioProductRange, intent: StructureIntent, options: { signal?: AbortSignal; onStart?: () => void; wait?: () => Promise<void> } = {}) {
  checkStopped(options.signal);
  let state = await io.read();
  checkStopped(options.signal);
  checkScope(state, scope);
  const reused = state.analysis.status === 'complete' && !state.analysis.stale && !intent.rerun;
  if (!reused && state.analysis.status !== 'running') {
    if (state.analysis.status === 'failed' && !intent.retry && !intent.rerun) throw new Error(`${state.analysis.error || '上次结构分析失败或提交状态不确定'}；不会自动重试。核查后请明确说“重试本段结构”。`);
    if (state.analysisPlan?.enabled === false) throw new Error('文字分析服务未启用或缺少配置，未发起请求。');
    if (state.analysisPlan?.error) throw new Error(state.analysisPlan.error);
    const plan = state.workflowPlan ? structuredClone(state.workflowPlan) : undefined;
    if (typeof io.confirm !== 'function' || !await io.confirm(state)) throw Object.assign(new Error('已取消结构分析，未发起请求。'), { code: 'STRUCTURE_CANCELLED' });
    checkStopped(options.signal);
    options.onStart?.();
    // A failed POST may already have reached the model. Never retry this POST in a catch or polling loop.
    state = await io.start({ retryFailed: intent.retry, rerun: intent.rerun, ...(state.analysisPlan?.inputIdentity ? { expectedInputIdentity: state.analysisPlan.inputIdentity } : {}), ...(plan ? { plan } : {}) });
    checkStopped(options.signal);
    checkScope(state, scope);
  }
  while (state.analysis.status === 'running') {
    await (options.wait?.() ?? delay(options.signal));
    checkStopped(options.signal);
    state = await io.read();
    checkStopped(options.signal);
    checkScope(state, scope);
  }
  if (state.analysis.status !== 'complete' || state.analysis.stale) throw new Error(`${state.analysis.error || '结构任务未完成'}；未自动重试。`);
  io.refresh();
  return { analysis: state.analysis, reused };
}
