import React from 'react';
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
      if (publishOnly) await api.publishSharedAnalysis(projectId, plan.sourceId, plan.shared!.taskKey);
      else await api.executeProductWorkflow(projectId, plan, reviewed);
      if (!stillCurrent()) return;
      await onDone();
      if (stillCurrent()) onClose();
    } catch (reason) {
      if (!stillCurrent()) return;
      setError(String((reason as Error).message ?? reason));
      // The POST may have reached the service. Return to task state before offering an explicit retry.
      setPlan(null);
    } finally { if (stillCurrent()) { submitted.current = false; setBusy(false); } }
  };
  const label = names[request.action];
  const from = plan?.scope?.startMs ?? 0, to = plan?.scope?.endMs ?? plan?.source.durationMs ?? 0;
  const sharedReuse = plan?.shared?.mode === 'reuse';
  const displayedService = sharedReuse ? plan.shared?.result?.service : plan?.service;
  const visualRequests = plan?.visual?.requestCount ?? 0;
  const textRequests = plan?.requestCount == null ? null : Math.max(0, plan.requestCount - visualRequests);
  return <div role="dialog" aria-label={`确认${label}`} className="mt-2 space-y-2 rounded border border-[var(--accent)]/40 p-2 text-[11px] animate-in fade-in duration-150">
    {preparingProducts && request.action !== 'analysis' && <p>{request.action === 'transcription' ? '拆商品 · 第 1 步：转写直播。完成后点“继续拆商品”，再单独确认下一步。' : '拆商品 · 第 2 步：识别商品。完成后选择商品段分析话术。'}</p>}
    {!plan && !error && <p>正在读取请求计划…</p>}
    {plan && <>
      {plan.newVersion && <p>{plan.cached ? '已有新版结果，本次不重复请求；当前工程继续使用原版本，请在版本列表中手动采用。' : '本次将生成新的共享版本，需要新请求；当前工程继续使用原版本，完成后由你决定是否采用。'}</p>}
      <p>{reviewBlocked ? '分段音频已经处理完成，接缝需原分析者在本机核对。本次不能再次转写，也不代表共享结果已完成。' : publishOnly ? '分析结果已在本机保存，本次只补存共享文件，不请求模型。' : sharedBusy ? '其他人已领取此任务，本次不会重复发送。' : plan.shared?.mode === 'reuse' ? '使用已保存的共享版本，本次不请求模型。人工修改只留本机。' : plan.cached ? '已有有效结果，本次不请求模型。' : request.action === 'transcription' ? '仅发送原片音轨进行转写；完成后等待单独确认文字拆品。' : visualRequests > 0 ? '发送本次讲解的转写原话、原片时间和识别指令；另将本讲解抽帧与对应原话发送给看图模型，不发送原音。' : '仅发送转写文字、原片时间和识别指令，不发送音频或画面。'}</p>
      {plan.shared?.reason && <p>{plan.shared.reason}</p>}
      {plan.shared?.mode === 'publish' && <p>取得共享任务后才开始分析；首个完成的 AI 结果供同事复用。</p>}
      {plan.shared?.result && <p className="break-all text-[var(--text-muted)]">共享版本标识：{plan.shared.result.sha256.slice(0, 12)}{plan.shared.result.service?.model ? ` · 原分析模型 ${plan.shared.result.service.model}` : ''}</p>}
      <p className="break-all">素材：{plan.source.assetPath}</p>
      <p>范围：{sourceTime(from)} – {sourceTime(to)}</p>
      <p>服务：{displayedService?.name || displayedService?.provider || (sharedReuse ? '旧结果未记录' : '未配置')} · {displayedService?.model || (sharedReuse ? '旧结果未记录' : '未配置')}</p>
      <p className="break-all">{sharedReuse ? '原发送至' : '发送至'}：{displayedService?.endpoint || (sharedReuse ? '旧结果未记录' : '未配置')}</p>
      <p>预计新增请求：{plan.requestCount ?? '尚无法确定'} 次 · 复用已完成 {plan.reusedRequests} 段</p>
      {request.action === 'analysis' && plan.visual && <>
        <p>其中：文字分析 {textRequests ?? '尚无法确定'} 次 ＋ AI 看图 {visualRequests} 次</p>
        {visualRequests > 0 && <><p>看图服务：{plan.visual.name || plan.visual.provider || '未配置'} · {plan.visual.model || '未配置'} · 最多 {plan.visual.maxImages} 张拼图</p><p className="break-all">画面发送至：{plan.visual.endpoint || '未配置'}</p><p>AI 看图请求可能计费，费用以服务账单为准。仅核查抽帧，不代表已核实连续动作或原音。</p></>}
        {!plan.visual.enabled && !plan.cached && !sharedReuse && <p>AI 看图未配置：本次只做文字分析，画面仍待核查。{plan.visual.error}</p>}
      </>}
      {plan.transcriptSegments != null && <p>转写文字：{plan.transcriptSegments} 条</p>}
      {!!plan.audioSegments?.length && <details><summary className="cursor-pointer">音频发送范围 · {plan.audioSegments.length} 段</summary>{plan.audioSegments.map((range, index) => <p key={index}>{sourceTime(range.startMs)} – {sourceTime(range.endMs)}</p>)}</details>}
      <p>{plan.cost.basis}</p>
      {!plan.cached && !publishOnly && !sharedBusy && plan.cost.uncertain && <p>费用暂不能准确估算，实际以服务账单为准。</p>}
      {plan.rerun && !plan.cached && !publishOnly && <p>本次重新分析会产生新请求；人工修正和取用修改保留。</p>}
      {plan.retryRequired && !reviewBlocked && <label className="flex items-start gap-2"><input type="checkbox" aria-label="已核查服务记录，确认显式重试" checked={reviewed} onChange={event => setReviewed(event.target.checked)} />已核查服务记录，确认重试未完成部分，可能再次计费</label>}
      {(plan.error || (!plan.enabled && !plan.cached && !publishOnly && !sharedBusy && !reviewBlocked)) && <p role="alert" className="text-red-400">{plan.error || plan.service.error || '请先在设置中配置此服务。已有结果仍保留。'}</p>}
    </>}
    {error && <p role="alert" className="text-red-400">{error}</p>}
    <div className="flex gap-1">
      <button type="button" className={button} disabled={disabled} onClick={() => void execute()}>{reviewBlocked ? '等待接缝核对' : sharedBusy ? '等待共享结果' : publishOnly ? '仅重试保存共享结果' : plan?.shared?.mode === 'reuse' ? '使用共享版本' : plan?.cached ? '使用已保存结果' : `确认${label}`}</button>
      <button type="button" className={button} disabled={busy} onClick={onClose}>{error ? '返回任务状态' : '取消'}</button>
      {(error || sharedBusy) && !busy && <button type="button" className={button} onClick={() => setTick(value => value + 1)}>重新读取计划</button>}
    </div>
  </div>;
}
