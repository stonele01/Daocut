import React from 'react';
import { ExistingAnalysisSharing } from './ExistingAnalysisSharing';
import { api, type ProductWorkflowStatus, type ProductWorkflowRequest } from '@/api';
import { sourceTime, type ProductAnalysis } from '@/lib/product-analysis';
import { ProductWorkflowConfirmation } from './ProductWorkflowConfirmation';
import { TranscriptSeamReview } from './TranscriptSeamReview';
import { ProductSharedVersions } from './ProductSharedVersions';

const button = 'rounded border border-[var(--border)] px-2 py-1 text-[11px] transition duration-150 hover:bg-[var(--bg-hover)] active:scale-95 disabled:opacity-40';

/** Completed ASR stays ready on reopen. Text discovery always requires its own approval. */
export function ProductPreparation({ projectId, source, onReady, refreshKey = 0, onLocate }: {
  projectId: string; source: ProductAnalysis['sources'][number]; onReady: () => Promise<void>; refreshKey?: number;
  onLocate: (sourceId: string, ms: number, candidateId?: string, play?: boolean) => void;
}) {
  const [state, setState] = React.useState<ProductWorkflowStatus | null>(null);
  const [error, setError] = React.useState('');
  const [confirm, setConfirm] = React.useState<ProductWorkflowRequest | null>(null);
  const [binding, setBinding] = React.useState(false);
  const [tick, setTick] = React.useState(0);
  const [publishing, setPublishing] = React.useState(false);
  const [published, setPublished] = React.useState('');
  const refreshed = React.useRef(false);
  const sourceKey = `${projectId}\0${source.id}`;
  const previousSource = React.useRef(sourceKey);
  const onReadyRef = React.useRef(onReady); onReadyRef.current = onReady;
  React.useEffect(() => {
    if (previousSource.current === sourceKey) return;
    previousSource.current = sourceKey;
    refreshed.current = false;
    setState(null); setConfirm(null); setError(''); setPublished('');
    setBinding(false); setPublishing(false);
  }, [sourceKey]);
  React.useEffect(() => {
    let cancelled = false, timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const next = await api.productWorkflowStatus(projectId, source.id);
        if (cancelled) return;
        setState(next); setError('');
        if (next.ready && !refreshed.current) { refreshed.current = true; await onReadyRef.current(); }
        if (!cancelled && (next.busy || next.shared?.mode === 'busy' || next.transcription.status === 'running' || next.discovery.status === 'running')) timer = setTimeout(load, next.shared?.mode === 'busy' ? 3000 : 1000);
      } catch (reason) { if (!cancelled) setError(String((reason as Error).message ?? reason)); }
    };
    void load(); return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [projectId, source.id, tick, refreshKey]);
  const busy = state?.busy || publishing || state?.shared?.mode === 'busy' || state?.transcription.status === 'running' || state?.discovery.status === 'running';
  const publishPending = state?.shared?.mode === 'publish-pending';
  // The original analyst can continue with a complete local correction. Coworkers without it must wait.
  const reviewBlocked = state?.shared?.mode === 'local-review' && state.transcription.status !== 'complete';
  const recovery = state?.shared?.mode === 'retry-required' && state.shared.action
    && (state.shared.action !== 'analysis' || (state.shared.scope?.productId && state.shared.scope.intervalId))
    ? { sourceId: source.id, action: state.shared.action, retry: true, ...(state.shared.newVersion ? { newVersion: true } : {}), ...(state.shared.action === 'analysis' ? { productId: state.shared.scope!.productId, intervalId: state.shared.scope!.intervalId } : {}) } satisfies ProductWorkflowRequest
    : null;
  const publish = async () => {
    if (publishing || !state?.shared?.taskKey) return;
    setPublishing(true); setError(''); setPublished('');
    try {
      await api.publishSharedAnalysis(projectId, source.id, state.shared.taskKey);
      setPublished('共享结果已保存'); setTick(value => value + 1);
    } catch (reason) { setError(String((reason as Error).message ?? reason)); }
    finally { setPublishing(false); }
  };
  const hasTranscript = state?.transcription.status === 'complete';
  const boundaryReview = state?.transcription.boundaryReview || state?.transcription.code === 'ASR_BOUNDARY_REVIEW';
  return <section aria-label="素材准备" className="mt-2 space-y-2">
    {!state && !error && <p>正在读取素材状态…</p>}
    {state && <>
      {state.shared && <details open={!!(reviewBlocked || publishPending || recovery || state.shared.mode === 'busy')} aria-label="共享分析状态" className="space-y-1 rounded border border-[var(--border)] p-2 transition-all duration-150">
        <summary className="cursor-pointer text-[var(--text-muted)] transition-colors hover:text-[var(--accent)]">共享状态</summary>
        <p>{reviewBlocked ? '分段已完成，接缝待原分析者核对' : state.shared.mode === 'local-review' ? '本机接缝已核对，可继续拆品；修正不共享' : state.shared.mode === 'busy' ? '同事正在分析，完成后可复用' : publishPending ? '分析已保存在本机，共享文件尚未保存完成' : state.shared.mode === 'reuse' ? '已有共享首版，可直接复用' : state.shared.mode === 'retry-required' ? '上次共享任务未完成，请核查记录后明确重试' : state.shared.mode === 'local-only' ? '本次修改和分析仅保存在本机' : '共享分析已启用'}</p>
        {state.shared.reason && <p className="text-[var(--text-muted)]">{state.shared.reason}</p>}
        {publishPending && <button type="button" className={button} disabled={publishing} onClick={() => void publish()}>仅重试保存共享结果</button>}
        {publishPending && <p>只补存已完成的结果，不重新发送转写或模型请求。</p>}
        {recovery && <>
          {state.shared.scope && <p>{sourceTime(state.shared.scope.startMs)} – {sourceTime(state.shared.scope.endMs)}</p>}
          <button type="button" className={button} disabled={!!busy} onClick={() => setConfirm(recovery)}>核查并重试共享{recovery.action === 'analysis' ? '话术分析' : recovery.action === 'discovery' ? '拆品' : '转写'}</button>
        </>}
      </details>}
      {published && <p role="status">{published}</p>}
      {!reviewBlocked && <p role="status">{state.ready && hasTranscript ? '商品段已准备好' : state.transcription.status === 'running' ? '正在转写' : state.discovery.status === 'running' ? '正在拆商品' : boundaryReview ? '转写分段已保存，边界待核对' : hasTranscript ? '转写已就绪' : '尚需转写'}</p>}
      {!state.ready && !busy && !boundaryReview && !publishPending && !reviewBlocked && <p className="text-[var(--text-muted)]">{hasTranscript ? '单商品：在卡片选择整段后分析。多个商品：先拆商品。' : '先转写，再选择分析单商品或拆分整场。'}</p>}
      {(state.transcription.error || state.discovery.error) && <p className="text-[var(--warn)]">{state.transcription.error || state.discovery.error}</p>}
      {boundaryReview && <p>已完成分段保留，请在下面核对字幕接缝，无需再次上传音频。</p>}
      {state.binding ? <details open className="space-y-1"><summary>核对已有字幕来源</summary><p className="break-all">{state.binding.assetPath}</p><p>原片时长 {sourceTime(state.binding.durationMs)} · {state.binding.cueCount} 条字幕</p><p>字幕覆盖：{state.binding.coverage.map(([a, b]) => `${sourceTime(a)}–${sourceTime(b)}`).join('、')}</p><button type="button" className={button} disabled={binding} onClick={() => { setBinding(true); void api.bindProductTranscript(projectId, source.id, state.binding!.kind, state.binding!.identity).then(() => setTick(n => n + 1), reason => setError(String(reason.message ?? reason))).finally(() => setBinding(false)); }}>确认这些字幕属于此原片</button></details> : (!state.ready || !hasTranscript) && !busy && !boundaryReview && !publishPending && !recovery && !reviewBlocked && <button type="button" className={button} disabled={!!confirm} onClick={() => setConfirm({ sourceId: source.id, action: hasTranscript ? 'discovery' : 'transcription', retry: state.shared?.mode === 'retry-required' || (hasTranscript ? state.discovery.status === 'failed' : state.transcription.status === 'failed') })}>{(hasTranscript ? state.discovery.status : state.transcription.status) === 'failed' ? `核查后重试${hasTranscript ? '拆商品' : '转写'}` : hasTranscript ? '拆商品' : '转写'}</button>}
    </>}
    <ExistingAnalysisSharing key={`existing:${projectId}:${source.id}`} projectId={projectId} sourceId={source.id} sourcePath={source.assetPath} durationMs={source.durationMs} refreshKey={`${refreshKey}:${tick}`} onLocate={onLocate} onChanged={async () => { setTick(n => n + 1); await onReadyRef.current(); }} />
    <TranscriptSeamReview key={`${projectId}:${source.id}`} projectId={projectId} sourceId={source.id} refreshKey={`${refreshKey}:${tick}:${state?.transcription.status ?? ''}`} onLocate={onLocate} onSaved={async () => { setTick(n => n + 1); await onReadyRef.current(); }} />
    <ProductSharedVersions key={`versions:${projectId}:${source.id}`} projectId={projectId} sourceId={source.id} refreshKey={`${refreshKey}:${tick}:${state?.transcription.status ?? ''}`} onChanged={async () => { setTick(n => n + 1); await onReadyRef.current(); }} />
    {confirm && confirm.sourceId === source.id && <ProductWorkflowConfirmation key={`${projectId}:${JSON.stringify(confirm)}`} projectId={projectId} request={confirm} preparingProducts onClose={() => { setConfirm(null); setTick(n => n + 1); }} onDone={async () => { setTick(n => n + 1); }} />}
    {error && <p role="alert" className="text-red-400">{error} <button type="button" className={button} onClick={() => setTick(n => n + 1)}>重试读取素材状态</button></p>}
  </section>;
}
