import React from 'react';
import { api, type ProductDiscoveryState } from '@/api';
import { productEvidenceText, sourceTime, type ProductAnalysis, type ProductInterval } from '@/lib/product-analysis';
import { ProductPreparation } from './ProductPreparation';
import { ProductWorkflowConfirmation } from './ProductWorkflowConfirmation';
import { SharedAnalysisSettings } from './SharedAnalysisSettings';
import type { WorkspaceResource } from '@/lib/workspace-resources';

const button = 'rounded border border-[var(--border)] px-2 py-1 text-[11px] transition duration-150 hover:bg-[var(--bg-hover)] active:scale-95 disabled:opacity-40';
type Props = { files: readonly WorkspaceResource[]; currentSourcePath?: string; projectId: string; analysis: ProductAnalysis; dailyEntry?: boolean; onApplied: () => Promise<void>; onLocate: (sourceId: string, ms: number, candidateId?: string, play?: boolean) => void };

export function ProductDiscovery({ projectId, analysis, onApplied, onLocate, files, currentSourcePath, dailyEntry = false }: Props) {
  const [open, setOpen] = React.useState(!analysis.intervals.length);
  const videos = files.filter(file => file.kind === 'video' && !file.link?.missing && (!file.link?.source || file.link.source.status === 'available'));
  const [pickedPath, setPickedPath] = React.useState('');
  const videoPath = videos.some(file => file.path === pickedPath) ? pickedPath : videos.some(file => file.path === currentSourcePath) ? currentSourcePath! : videos[0]?.path ?? '';
  const register = async () => {
    if (!videoPath || busy) return;
    setBusy(true); setError('');
    try { const result = await api.registerProductSource(projectId, videoPath); await onApplied(); setSourceId(result.source.id); setObserving(true); }
    catch (reason) { setError(String((reason as Error).message ?? reason)); }
    finally { setBusy(false); }
  };

  const [observing, setObserving] = React.useState(false);
  const [sourceId, setSourceId] = React.useState(analysis.sources[0]?.id ?? '');
  const [state, setState] = React.useState<ProductDiscoveryState | null>(null);
  const [error, setError] = React.useState('');
  const [tick, setTick] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const [confirm, setConfirm] = React.useState<'discover' | 'restart' | 'apply' | null>(null);
  const [reviewed, setReviewed] = React.useState(false);
  const current = analysis.intervals.filter(i => i.sourceId === sourceId);
  const source = analysis.sources.find(s => s.id === sourceId);
  const proposal = state?.proposal;
  const replaceReviewed = current.length > 0 || !!state?.difference?.manualEdits || (analysis.unassigned ?? []).some(i => i.sourceId === sourceId) || (analysis.manualEdits ?? []).some(edit => edit.sourceIds.includes(sourceId));
  // Import creates a name-only placeholder product. It is not a reviewed split.
  const hasSavedResult = replaceReviewed
    || analysis.products.some(p => p.sourceIds.includes(sourceId) && (p.origin || p.discoveryRunId || p.evidence?.length || p.aliases?.length || p.review?.length))
    || [...analysis.candidates, ...(analysis.scopes ?? []), ...(analysis.archivedCandidates ?? [])].some(i => i.sourceId === sourceId)
    || (analysis.discoveryApplied ?? []).some(i => i.sourceId === sourceId);
  const alreadyApplied = (analysis.discoveryApplied ?? []).some(i => i.sourceId === sourceId && i.runId === proposal?.runId);
  React.useEffect(() => { if (!analysis.sources.some(s => s.id === sourceId)) setSourceId(analysis.sources[0]?.id ?? ''); }, [analysis.sources, sourceId]);
  React.useEffect(() => {
    if (!observing || !sourceId) return;
    let cancelled = false, timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try { const next = await api.productDiscovery(projectId, sourceId); if (cancelled) return; setState(next); setError(''); if (next.status === 'running') timer = setTimeout(load, 2000); }
      catch (e) { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); }
    };
    setState(null); void load();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [projectId, sourceId, observing, tick, analysis]);
  React.useEffect(() => { setConfirm(null); setReviewed(false); }, [sourceId, proposal?.runId]);
  const execute = async () => {
    if (!confirm || busy) return;
    setBusy(true); setError('');
    try {
      if (proposal) { await api.applyProductDiscovery(projectId, sourceId, proposal.runId, analysis, replaceReviewed && reviewed); await onApplied(); }
      setConfirm(null); setReviewed(false); setTick(n => n + 1);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const rangeList = (ranges: ProductInterval[], products: ProductAnalysis['products'], label: string) => <div className="mt-2 max-h-40 overflow-y-auto" aria-label={label}>{ranges.length ? ranges.map(range => <div key={range.id} className="border-t border-[var(--border)] py-1"><button className="block w-full text-left transition hover:text-[var(--accent)]" onClick={() => onLocate(range.sourceId, range.startMs)}>{products.find(p => p.id === range.productId)?.name ?? '待确认'} · {sourceTime(range.startMs)} – {sourceTime(range.endMs)}</button>{!!range.evidence?.length && <details className="mt-1 text-[10px] text-[var(--text-muted)]"><summary className="cursor-pointer">原话依据</summary>{range.evidence.map((e, n) => <p key={n}>{productEvidenceText(e)}</p>)}</details>}</div>) : <p className="text-[var(--text-muted)]">暂无范围</p>}</div>;
  const setup = <>
    <SharedAnalysisSettings onChanged={() => setTick(value => value + 1)} />
    {videos.length > 0 && <div className="mt-2 flex flex-col gap-1">
      <select aria-label="准备来源视频" value={videoPath} disabled={busy || !!confirm} onChange={event => setPickedPath(event.target.value)} className="rounded bg-[var(--dock-pane)] p-1">{videos.map(file => <option key={file.path} value={file.path}>{file.name}</option>)}</select>
      <button type="button" className={button} disabled={!videoPath || busy || !!confirm} onClick={() => void register()}>准备当前视频</button>
    </div>}
    <select aria-label="拆品来源视频" className="mt-2 w-full rounded bg-[var(--dock-pane)] p-1" value={sourceId} disabled={busy || !!confirm} onChange={e => setSourceId(e.target.value)}>{analysis.sources.map(s => <option key={s.id} value={s.id}>{s.assetPath}</option>)}</select>
  </>;
  return <details open={open} onToggle={event => { setOpen(event.currentTarget.open); if (event.currentTarget.open) setObserving(true); }} className="mb-3 rounded border border-[var(--border)] p-2.5 transition-all" aria-label="直播拆品设置">
    <summary className="cursor-pointer text-[var(--text-muted)] transition-colors hover:text-[var(--accent)]">{analysis.intervals.length ? '素材与拆品记录' : '准备素材'}</summary>
    {!dailyEntry && setup}
    {!source && <p className="mt-2 text-[var(--text-muted)]">请先接入来源视频</p>}
    {source && <ProductPreparation key={`${projectId}:${sourceId}`} projectId={projectId} source={source} refreshKey={tick} onLocate={onLocate} onReady={async () => { await onApplied(); setTick(n => n + 1); }} />}
    {dailyEntry && <details className="mt-2 text-[11px] text-[var(--text-muted)]" aria-label="素材与共享设置"><summary className="cursor-pointer transition hover:text-[var(--accent)]">素材与共享设置</summary>{setup}</details>}
    <details className="mt-2" aria-label="拆品高级操作"><summary className="cursor-pointer text-[10.5px] text-[var(--text-muted)]">重新拆品与原始记录</summary>
    <p className="mt-2 text-[10.5px] text-[var(--text-muted)]">已有范围和人工修正不会自动替换，重新拆品后可核对差异。</p>
    {source && !state && !error && <p className="mt-2">正在读取任务状态…</p>}
    {state && <>
      <p className="mt-2">拆品：{alreadyApplied ? '切点已保存' : { idle: '未开始', running: '进行中', complete: hasSavedResult ? '新切点待核对' : busy ? '正在保存切点' : '切点已生成', failed: '已中断或失败' }[state.status]}{state.error ? ` · ${state.error}` : ''}</p>
      <button className={`${button} mt-2`} disabled={busy || state.enabled === false || state.status === 'running' || (state.status === 'failed' && !state.canRetry)} onClick={() => setConfirm('discover')}>{state.status === 'failed' ? '显式重试拆品' : state.status === 'complete' ? '重新识别商品' : '识别多商品'}</button>
      {state.enabled === false && <p className="mt-1 text-[10.5px] text-[var(--text-muted)]">当前服务未启用文字拆品。已有建议和人工结果仍可读取。</p>}
      {state.status === 'failed' && !state.canRetry && <p className="mt-1 text-[10.5px] text-[var(--warn)]">提交状态未确认，请先核查服务记录。</p>}
      {state.status === 'failed' && <button className={`${button} mt-2`} disabled={busy || state.enabled === false} onClick={() => setConfirm('restart')}>重新识别为新批次</button>}
      {!!state.runs?.length && <details className="mt-2 text-[10.5px]"><summary className="cursor-pointer">分段与任务记录</summary>{state.runs.map(run => <p key={run.id} className="mt-1 text-[var(--text-muted)]">{run.createdAt} · {run.status} · {run.completedWindows ?? 0}/{run.windows ?? '—'} 段{run.error ? ` · ${run.error}` : ''}</p>)}</details>}
    </>}
    {proposal && <details open={!alreadyApplied} className="mt-3 border-t border-[var(--border)] pt-2" aria-label="拆品建议差异">
      <summary className="cursor-pointer font-medium">{alreadyApplied ? '原始 AI 切点与依据' : '建议与当前范围'}</summary>
      <p className="mt-1 text-[10.5px] text-[var(--text-muted)]">{proposal.products.length} 个商品 · {proposal.intervals.length} 段讲解 · {proposal.unassigned.length} 段待确认</p>
      {state?.difference && <p className="mt-1 text-[10.5px]">商品新增 {state.difference.addedProducts} / 移除 {state.difference.removedProducts} / 改名 {state.difference.renamedProducts}；范围新增 {state.difference.addedIntervals} / 移除 {state.difference.removedIntervals} / 调整 {state.difference.changedIntervals}</p>}
      <details className="mt-2" open><summary className="cursor-pointer">建议范围</summary>{rangeList(proposal.intervals, proposal.products, '建议讲解范围')}{proposal.products.map(p => <div key={p.id} className="mt-1 text-[10.5px] text-[var(--text-muted)]">{!!p.aliases?.length && <p>{p.name}别名：{p.aliases.map(a => `${a.name}（${a.evidence.map(productEvidenceText).join('；') || '待核实'}）`).join('、')}</p>}{!!p.review?.length && <p>{p.name}：{p.review.join('；')}</p>}</div>)}</details>
      <details className="mt-2"><summary className="cursor-pointer">当前已保存范围</summary>{rangeList(current, analysis.products, '当前讲解范围')}</details>
      {!!proposal.unassigned.length && <details className="mt-2"><summary className="cursor-pointer">建议待确认段</summary>{proposal.unassigned.map(r => <p key={r.id} className="mt-1 text-[10.5px]">{sourceTime(r.startMs)} – {sourceTime(r.endMs)} · {r.reason}</p>)}</details>}
      {!!proposal.issues.length && <details className="mt-2"><summary className="cursor-pointer">识别备注</summary>{proposal.issues.map((issue, i) => <p key={i} className="mt-1 text-[10.5px] text-[var(--text-muted)]">{issue}</p>)}</details>}
      {!alreadyApplied && <button className={`${button} mt-2`} disabled={busy || state?.status === 'running'} onClick={() => { setConfirm('apply'); setReviewed(false); }}>核对并应用建议</button>}
    </details>}
    {confirm && confirm !== 'apply' && <ProductWorkflowConfirmation key={`${sourceId}:${confirm}`} projectId={projectId}
      request={{ sourceId, action: 'discovery', rerun: confirm === 'restart' || state?.status === 'complete', retry: state?.status === 'failed' }}
      onDone={async () => { const next = await api.productDiscovery(projectId, sourceId); setState(next); setObserving(true); setTick(n => n + 1); }}
      onClose={() => { setConfirm(null); setTick(n => n + 1); }} />}
    {confirm === 'apply' && <div role="dialog" aria-label="确认应用拆品建议" className="mt-2 space-y-2 rounded border border-[var(--accent)]/40 p-2">
      <p>应用将更新商品和讲解归属，保留原始 AI 建议和修改前记录。</p>
      {replaceReviewed && <label className="flex items-start gap-2 text-[10.5px]"><input type="checkbox" aria-label="确认替换已复核范围" checked={reviewed} onChange={event => setReviewed(event.target.checked)} />已核对差异，确认替换已有商品范围和人工修正</label>}
      <div className="flex gap-1"><button className={button} disabled={busy || (replaceReviewed && !reviewed)} onClick={() => void execute()}>确认应用</button><button className={button} disabled={busy} onClick={() => setConfirm(null)}>取消</button></div>
    </div>}

    {error && <p role="alert" className="mt-2 text-red-400">{error} <button className={button} disabled={busy} onClick={() => setTick(n => n + 1)}>重试读取</button></p>}
    </details>
  </details>;
}
