import React from 'react';
import { api } from '@/api';
import type { StructureScope } from '@/lib/structure-workspace';
import { sourceTime } from '@/lib/product-analysis';
import { visualReviewCanSubmit, visualReviewPresentation, type ProductVisualPlan, type ProductVisualReview } from '@/lib/product-visual-review';

const button = 'rounded border border-[var(--border)] px-2 py-1 text-[11px] transition duration-150 hover:bg-[var(--bg-hover)] active:scale-95 disabled:opacity-40';

export function ProductVisualReviewDetails({ review, origin = 'saved', label = '已保存的 AI 看图核查', stale = false }: { review?: ProductVisualReview; origin?: 'shared' | 'local' | 'saved'; label?: string; stale?: boolean }) {
  const view = visualReviewPresentation(review, origin, stale);
  return <details className="mt-2 text-[11px] text-[var(--text-muted)]" aria-label={label}>
    <summary className="cursor-pointer transition-colors hover:text-[var(--accent)]">{view.summary}</summary>
    <div className="mt-1 max-h-52 overflow-auto animate-in fade-in slide-in-from-top-1 duration-150">
      {view.originLabel && <p>{view.originLabel}</p>}{view.range && <p>原片范围：{view.range}</p>}{view.productName && <p>{view.productName}</p>}<p>{view.note}</p>
      {view.entries.map((entry, index) => <div key={index} className="mt-2 border-t border-[var(--border)] pt-1"><p>{entry.range}</p><p>{entry.product} · {entry.display}</p><p>{entry.observation}</p><p>{entry.evidence}</p>{entry.issues.map((issue, i) => <p key={i} className="text-[var(--warn)]">{issue}</p>)}</div>)}
      {view.issues.map((issue, index) => <p key={index} className="mt-1 text-[var(--warn)]">{issue}</p>)}
    </div>
  </details>;
}

/** Opening reads a plan only; the separate confirmation sends the exact paid request. */
export function ProductVisualReviewConfirmation({ projectId, scope, onDone, onClose }: { projectId: string; scope: StructureScope; onDone: () => Promise<void>; onClose: () => void }) {
  const [plan, setPlan] = React.useState<ProductVisualPlan | null>(null);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [reviewed, setReviewed] = React.useState(false);
  const [tick, setTick] = React.useState(0);
  const mounted = React.useRef(true), submitted = React.useRef(false);
  const key = `${projectId}:${JSON.stringify(scope)}`;
  const currentKey = React.useRef(key); currentKey.current = key;
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  React.useEffect(() => {
    let active = true; submitted.current = false; setPlan(null); setError(''); setBusy(false); setReviewed(false);
    void api.productVisualPlan(projectId, scope).then(value => { if (active) setPlan(value); }, reason => { if (active) setError(String(reason.message ?? reason)); });
    return () => { active = false; };
  }, [key, tick]);
  const disabled = busy || !visualReviewCanSubmit(plan, reviewed);
  const submit = async () => {
    if (!plan || disabled || submitted.current) return;
    submitted.current = true; setBusy(true); setError('');
    const stillCurrent = () => mounted.current && currentKey.current === key;
    try { await api.reviewProductVisual(projectId, plan, reviewed); if (!stillCurrent()) return; await onDone(); if (stillCurrent()) onClose(); }
    catch (reason) { if (stillCurrent()) { setError(String((reason as Error).message ?? reason)); setPlan(null); } }
    finally { if (stillCurrent()) { submitted.current = false; setBusy(false); } }
  };
  return <div role="dialog" aria-label="确认 AI 看图核查" className="mt-2 space-y-2 rounded border border-[var(--accent)]/40 p-2 text-[11px] animate-in fade-in duration-150">
    {!plan && !error && <p>正在读取看图请求计划…</p>}
    {plan && <>
      <p>{plan.recoverable ? '模型返回已收到，本次只恢复和保存已有结果，不发送模型请求。' : plan.cached ? '复用已保存的 AI 看图结果，本次不请求模型。' : '发送本次讲解的抽帧画面、对应原话与商品名称进行 AI 看图核查，不发送原音。'}</p>
      <p>范围：{sourceTime(plan.scope.startMs)} – {sourceTime(plan.scope.endMs)}</p>
      <p>看图服务：{plan.service.name || plan.service.provider || '未配置'} · {plan.service.model || '未配置'}</p>
      <p className="break-all">发送至：{plan.service.endpoint || '未配置'}</p>
      <p>预计新增请求：文字分析 0 次 ＋ AI 看图 {plan.requestCount} 次 · 最多 {plan.maxImages} 张拼图</p>
      {!plan.cached && !plan.recoverable && <p>看图请求可能计费，费用以服务账单为准。结果或费用不明确时不会自动重发。</p>}
      <p>补查结果留在当前工程，公共底稿和已有个人草稿保留。</p>
      {plan.retryRequired && <label className="flex items-start gap-2"><input type="checkbox" aria-label="已核查看图服务记录，确认显式重试" checked={reviewed} onChange={event => setReviewed(event.target.checked)} />已核查服务记录，确认显式重试，可能再次计费</label>}
      {(plan.error || (!plan.enabled && !plan.cached && !plan.recoverable)) && <p role="alert" className="text-red-400">{plan.error || plan.service.error || '未配置可用看图服务，已有结果保留。'}</p>}
    </>}
    {error && <p role="alert" className="text-red-400">{error}</p>}
    <div className="flex gap-1"><button type="button" className={button} disabled={disabled} onClick={() => void submit()}>{busy ? '正在核查…' : plan?.recoverable ? '恢复已收到的结果' : plan?.cached ? '使用已保存结果' : '确认 AI 看图核查'}</button><button type="button" className={button} disabled={busy} onClick={onClose}>{error ? '返回任务状态' : '取消'}</button>{error && !busy && <button type="button" className={button} onClick={() => setTick(value => value + 1)}>重新读取计划</button>}</div>
  </div>;
}
