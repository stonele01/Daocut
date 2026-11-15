import React from 'react';
import { createPortal } from 'react-dom';
import { api, type ProductWorkflowPlan, type ProductWorkflowRequest } from '@/api';
import { sourceTime } from '@/lib/product-analysis';

const button = 'rounded border border-[var(--border)] px-2 py-1 text-[11px] transition duration-150 hover:bg-[var(--bg-hover)] active:scale-95 disabled:opacity-40';
const names = { transcription: '转写', discovery: '拆品', analysis: '分析' };

/** Read-only planning precedes every paid stage. Only the explicit button submits this exact plan. */
export function ProductWorkflowConfirmation({ projectId, request, onDone, onClose, preparingProducts = false }: {
  projectId: string; request: ProductWorkflowRequest; onDone: () => Promise<void>; onClose: () => void;
  preparingProducts?: boolean;
}) {
  const [plan, setPlan] = React.useState<ProductWorkflowPlan | null>(null);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [reviewed, setReviewed] = React.useState(false);
  const [tick, setTick] = React.useState(0);
  const requestKey = JSON.stringify(request);
  const executionKey = `${projectId}\0${requestKey}`;
  const currentKey = React.useRef(executionKey); currentKey.current = executionKey;
  const mounted = React.useRef(true);
  const submitted = React.useRef(false);
  const dialog = React.useRef<HTMLDivElement>(null);
  const cancel = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    cancel.current?.focus();
    return () => { previous?.focus?.(); };
  }, []);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  React.useEffect(() => {
    let active = true;
    submitted.current = false;
    setPlan(null); setError(''); setReviewed(false); setBusy(false);
    void api.productWorkflowPlan(projectId, request).then(value => { if (active) setPlan(value); }, reason => { if (active) setError(String(reason.message ?? reason)); });
    return () => { active = false; };
  }, [projectId, requestKey, tick]);
  const sharedBusy = plan?.shared?.mode === 'busy';
  const reviewBlocked = plan?.shared?.mode === 'local-review';
  const publishOnly = plan?.shared?.mode === 'publish-pending';
  const disabled = busy || !plan || sharedBusy || reviewBlocked || !!plan.error || (!plan.enabled && !plan.cached && !publishOnly) || (plan.retryRequired && !reviewed);
  const execute = async () => {
    if (submitted.current || !plan || disabled) return;
    submitted.current = true; setBusy(true); setError('');
    const stillCurrent = () => mounted.current && currentKey.current === executionKey;
    try {
      if (publishOnly && !request.prepare) await api.publishSharedAnalysis(projectId, plan.sourceId, plan.shared!.taskKey);
      else await api.executeProductWorkflow(projectId, plan, reviewed);
      if (!stillCurrent()) return;
      if (stillCurrent()) onClose();
      await onDone();
    } catch (reason) {
      if (!stillCurrent()) return;
      setError(String((reason as Error).message ?? reason));
      // The POST may have reached the service. Return to task state before offering an explicit retry.
      setPlan(null);
    } finally { if (stillCurrent()) { submitted.current = false; setBusy(false); } }
  };
  const label = request.prepare ? '转写并拆品' : names[request.action];
  const from = plan?.scope?.startMs ?? 0, to = plan?.scope?.endMs ?? plan?.source.durationMs ?? 0;
  const sharedReuse = plan?.shared?.mode === 'reuse';
  const displayedService = sharedReuse ? plan.shared?.result?.service : plan?.service;
  const visualRequests = plan?.visual?.requestCount ?? 0;
  const textRequests = plan?.requestCount == null ? null : Math.max(0, plan.requestCount - visualRequests);
  return createPortal(<div className="fixed inset-0 z-[10100] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px] animate-in fade-in duration-150">
    <div ref={dialog} role="dialog" aria-modal="true" aria-label={`确认${label}`} className="flex max-h-[min(80vh,36rem)] w-full max-w-[420px] flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--dock-pane)] text-[12px] text-[var(--text)] shadow-xl animate-in fade-in zoom-in-95 duration-150" onKeyDown={event => {
      if (event.key === 'Escape' && !busy) { event.stopPropagation(); onClose(); }
      if (event.key !== 'Tab') return;
      const nodes = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),summary') ?? []);
      if (event.shiftKey && document.activeElement === nodes[0]) { event.preventDefault(); nodes.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === nodes.at(-1)) { event.preventDefault(); nodes[0]?.focus(); }
    }}>
    <div className="min-h-0 space-y-3 overflow-y-auto p-4">
    <strong className="block text-[15px]">{request.prepare ? '转写并拆品' : preparingProducts && request.action !== 'analysis' ? request.action === 'transcription' ? '转写直播' : '识别商品' : `确认${label}`}</strong>
    {!plan && !error && <p>正在读取请求计划…</p>}
    {plan && <>
      {request.prepare && <p>整条视频转写后自动识别商品；只有一个品就生成一个品。已有结果会复用，不自动开始话术分析。</p>}
      {plan.newVersion && <p>{plan.cached ? '已有新版结果，本次不重复请求；当前工程继续使用原版本，请在版本列表中手动采用。' : '本次将生成新的共享版本，需要新请求；当前工程继续使用原版本，完成后由你决定是否采用。'}</p>}
      {!request.prepare && <p>{reviewBlocked ? '分段已完成，待核对字幕接缝，无需重新转写。' : publishOnly ? '仅补存共享结果，不请求模型。' : sharedBusy ? '同事正在处理，等待共享结果。' : sharedReuse ? '复用共享结果，不请求模型。' : plan.cached ? '复用已保存结果，不请求模型。' : request.action === 'transcription' ? '将整条原视频的音频转成文字，各商品复用这份转写。' : visualRequests > 0 ? '分析所选讲解的文字，并发送抽帧进行看图核查。' : '仅发送转写文字、时间和识别指令。'}</p>}
      {plan.shared?.reason && <p>{plan.shared.reason}</p>}
      <p className="break-all">素材：{plan.source.assetPath}</p>
      <p>范围：{sourceTime(from)} – {sourceTime(to)}</p>
      <p>服务：{displayedService?.name || displayedService?.provider || (sharedReuse ? '旧结果未记录' : '未配置')} · {displayedService?.model || (sharedReuse ? '旧结果未记录' : '未配置')}</p>
      {plan.nextStage && <p>接着拆品：{plan.nextStage.service.name || plan.nextStage.service.provider} · {plan.nextStage.service.model}。拆品请求次数在转写完成后按文字长度确定。</p>}
      <p>{plan.nextStage ? '转写新增请求' : '新增请求'} {plan.requestCount ?? '待确定'} 次{plan.reusedRequests > 0 ? ` · 复用 ${plan.reusedRequests} 段` : ''}</p>
      {request.action === 'analysis' && plan.visual && <>
        <p>其中：文字分析 {textRequests ?? '尚无法确定'} 次 ＋ AI 看图 {visualRequests} 次</p>
        {visualRequests > 0 && <p>看图：{plan.visual.name || plan.visual.provider || '未配置'} · {plan.visual.model || '未配置'}</p>}
        {!plan.visual.enabled && !plan.cached && !sharedReuse && <p>AI 看图未配置：本次只做文字分析，画面仍待核查。{plan.visual.error}</p>}
      </>}
      {(!plan.cached || !!plan.nextStage) && !publishOnly && !sharedBusy && (plan.cost.uncertain || !!plan.nextStage) && <p className="text-[var(--text-muted)]">本次请求可能计费，费用以服务账单为准。</p>}
      {plan.rerun && !plan.cached && !publishOnly && <p>本次重新分析会产生新请求；人工修正和取用修改保留。</p>}
      {plan.retryRequired && !reviewBlocked && <label className="flex items-start gap-2"><input type="checkbox" aria-label="已核查服务记录，确认显式重试" checked={reviewed} onChange={event => setReviewed(event.target.checked)} />已核查服务记录，确认重试未完成部分，可能再次计费</label>}
      {(plan.error || (!plan.enabled && !plan.cached && !publishOnly && !sharedBusy && !reviewBlocked)) && <p role="alert" className="text-red-400">{plan.error || plan.service.error || '请先在设置中配置此服务。已有结果仍保留。'}</p>}
      <details aria-label="请求详情" className="text-[var(--text-muted)]">
        <summary className="cursor-pointer transition-colors hover:text-[var(--accent)]">请求与费用详情</summary>
        <div className="mt-2 space-y-2 animate-in fade-in slide-in-from-top-1 duration-150">
          <p className="break-all">{sharedReuse ? '原发送至' : '发送至'}：{displayedService?.endpoint || (sharedReuse ? '旧结果未记录' : '未配置')}</p>
          {plan.transcriptSegments != null && <p>转写文字：{plan.transcriptSegments} 条</p>}
          {!!plan.audioSegments?.length && <div>音频范围 · {plan.audioSegments.length} 段{plan.audioSegments.map((range, index) => <p key={index}>{sourceTime(range.startMs)} – {sourceTime(range.endMs)}</p>)}</div>}
          {visualRequests > 0 && plan.visual && <><p className="break-all">画面发送至：{plan.visual.endpoint || '未配置'}</p><p>最多 {plan.visual.maxImages} 张抽帧拼图；不代表已核实连续动作或原音。</p></>}
          <p>{plan.cost.basis}</p>
          {plan.shared?.mode === 'publish' && <p>首次分析结果供同事复用。</p>}
          {plan.shared?.result && <p>共享版本：{plan.shared.result.sha256.slice(0, 12)}</p>}
        </div>
      </details>
    </>}
    {error && <p role="alert" className="text-red-400">{error}</p>}
    </div>
    <div className="flex shrink-0 flex-wrap gap-2 border-t border-[var(--border)] bg-[var(--dock-pane)] p-4">
      <button type="button" className={`${button} min-h-9 flex-1 bg-[var(--accent)]/20 text-[var(--text)]`} disabled={disabled} onClick={() => void execute()}>{busy ? '正在启动…' : reviewBlocked ? '等待接缝核对' : sharedBusy ? '等待共享结果' : publishOnly ? '仅重试保存共享结果' : request.prepare ? '确认转写并拆品' : plan?.shared?.mode === 'reuse' ? '使用共享版本' : plan?.cached ? '使用已保存结果' : `确认${label}`}</button>
      <button ref={cancel} type="button" className={`${button} min-h-9 px-4`} disabled={busy} onClick={onClose}>{error ? '返回任务状态' : '取消'}</button>
      {(error || sharedBusy) && !busy && <button type="button" className={button} onClick={() => setTick(value => value + 1)}>重新读取计划</button>}
    </div>
  </div></div>, document.body);
}
