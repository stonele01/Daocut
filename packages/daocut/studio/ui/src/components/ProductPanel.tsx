import React from 'react';
import { api, type LiveAnalysisState, type ProductWorkflowStatus, type SharedProjectOpen } from '@/api';
import { sourceTime, visibleProducts, savedStructureRange, productAnalysisRange, productResultRanges, productResultCandidates, isRecoveredProduct, type ProductAnalysis, type ProductInterval } from '@/lib/product-analysis';
import { structureColor } from '@/lib/structure-colors';
import { displayStructureTag, displayStructureTags, hasStructureTag, productStructureTags } from '@/lib/product-structure-tags';
import type { WorkspaceResource } from '@/lib/workspace-resources';
import { applyProductEdit, productRangeSummary } from '@/lib/product-manual';
import { ProductRanges } from './ProductRanges';
import { ProductDiscovery } from './ProductDiscovery';
import { VirtualList } from './VirtualList';
import { ProductWorkflowConfirmation } from './ProductWorkflowConfirmation';
import type { StructureScope } from '@/lib/structure-workspace';

export interface ProductPanelProps {
  onCompose?: (scope: StructureScope, generate?: boolean) => void;
  onReturnToProject?: () => void;
  analysis: ProductAnalysis; history: ProductAnalysis | null; files: readonly WorkspaceResource[];
  selectedProductId: string | null; tag: string; onTagChange: (tag: string) => void; canDragCandidate: (id: string) => boolean; onSelectProduct: (id: string) => void;
  rangeSelection: { sourceId: string; intervalId: string };
  onRangeSelectionChange: (selection: { sourceId: string; intervalId: string }) => void;
  onSave: (next: ProductAnalysis) => Promise<void>; onRestore: () => Promise<void>;
  onLocate: (sourceId: string, ms: number, candidateId?: string, play?: boolean) => void;
  onAddCandidate: (id: string) => void; sharedAdd?: React.ReactNode;
  onDragCandidate: (id: string, event: React.DragEvent) => void; onDragCandidateEnd: () => void;
  projectId: string; onAnalysisComplete: () => Promise<void>; currentSourcePath?: string;
  candidateUnavailable: (candidate: ProductAnalysis['candidates'][number]) => boolean;
  candidateHistorical: (candidate: ProductAnalysis['candidates'][number]) => boolean;
}
const btn = 'rounded border border-white/15 px-2 py-1 text-[11px] transition duration-150 hover:bg-white/10 active:scale-95 disabled:opacity-40';
const tags = productStructureTags;

function LiveAnalysis({ refreshKey, projectId, sources, ranges: productRanges, sourceId, intervalId, onSelectSource, onSelectRange, onLocate, onAnalysisComplete, onWorkflowStarted, onReviewTranscript, children }: { refreshKey: number; projectId: string; sources: ProductAnalysis['sources']; ranges: ProductAnalysis['intervals']; sourceId: string; intervalId: string; onSelectSource: (id: string) => void; onSelectRange: (id: string) => void; onLocate: ProductPanelProps['onLocate']; onAnalysisComplete: () => Promise<void>; onWorkflowStarted: () => void; onReviewTranscript: (discovery?: boolean) => void; children: (parts: { action: React.ReactNode; transcription: React.ReactNode; feedback: React.ReactNode; details: React.ReactNode }) => React.ReactNode }) {
  const ranges = productRanges.filter(r => r.sourceId === sourceId);
  const selectedRange = ranges.find(r => r.id === intervalId);
  const [state, setState] = React.useState<LiveAnalysisState | null>(null);
  const [preparation, setPreparation] = React.useState<ProductWorkflowStatus | null>(null);
  const [error, setError] = React.useState('');
  const [confirm, setConfirm] = React.useState<'transcribe' | 'analyze' | 'rerun' | null>(null);
  const [starting, setStarting] = React.useState(false);
  const [tick, setTick] = React.useState(0);
  const refreshedRuns = React.useRef(new Set<string>());
  const refreshCompleted = async (next: LiveAnalysisState) => {
    const runs = Object.values(next.analyses ?? { selected: next.analysis }).filter(a => a.status === 'complete' && a.currentRunId && !refreshedRuns.current.has(a.currentRunId)).map(a => a.currentRunId!);
    if (!runs.length) return;
    runs.forEach(id => refreshedRuns.current.add(id));
    try { await onAnalysisComplete(); }
    catch (error) { runs.forEach(id => refreshedRuns.current.delete(id)); throw error; }
  };
  const scope = `${projectId}:${sourceId}:${selectedRange?.id ?? ''}:${selectedRange?.startMs ?? ''}:${selectedRange?.endMs ?? ''}`;
  const currentScope = React.useRef(scope);
  currentScope.current = scope;
  const sourceKey = `${projectId}:${sourceId}`;
  const currentSource = React.useRef(sourceKey); currentSource.current = sourceKey;
  React.useEffect(() => {
    setConfirm(null);
  }, [scope]);
  React.useEffect(() => {
    if (!sourceId) { setState(null); return; }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const [next, prepared] = await Promise.all([api.liveAnalysis(projectId, sourceId).then(next => { if (!cancelled) setState(next); return next; }), api.productWorkflowStatus(projectId, sourceId)]);
        if (cancelled) return;
        setState(next); setPreparation(prepared); setError('');
        await refreshCompleted(next);
        const splitKey = prepared.discovery.runId && `discovery:${prepared.discovery.runId}`;
        if (prepared.discoveryReady && splitKey && !refreshedRuns.current.has(splitKey)) {
          refreshedRuns.current.add(splitKey);
          try { await onAnalysisComplete(); } catch (error) { refreshedRuns.current.delete(splitKey); throw error; }
        }
        if (cancelled) return;
        if (next.transcription.status === 'running' || Object.values(next.analyses ?? { selected: next.analysis }).some(a => a.status === 'running') || prepared.busy || prepared.discovery.status === 'running') timer = setTimeout(load, 1000);
      } catch (e) { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); }
    };
    void load();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [projectId, sourceId, tick, refreshKey]);
  const requestFinished = async () => {
    const submittedScope = scope;
    setStarting(true); setError('');
    try {
      const next = await api.liveAnalysis(projectId, sourceId);
      await refreshCompleted(next);
      if (currentSource.current !== sourceKey) return;
      setState(next);
      if (currentScope.current === submittedScope) setConfirm(null);
      onWorkflowStarted();
      setTick((n) => n + 1);
    } catch (e) { if (currentScope.current === submittedScope) { setError(e instanceof Error ? e.message : String(e)); setConfirm(null); } }
    finally { setStarting(false); }
  };
  React.useEffect(() => { setState(null); setPreparation(null); }, [projectId, sourceId]);
  const selectedAnalysis = state?.analyses?.[intervalId] ?? (state?.analysis.intervalId === intervalId ? state.analysis : undefined);
  const runningAnalysis = Object.values(state?.analyses ?? { selected: state?.analysis }).find(a => a?.status === 'running');
  const status = (s: string) => ({ idle: '未开始', running: '进行中', complete: '已完成', failed: '失败' }[s] ?? s);
  const selectedComplete = selectedAnalysis?.status === 'complete' && selectedAnalysis?.intervalId === selectedRange?.id;
  const analyzing = starting || !!runningAnalysis;
  const rangeLabel = selectedRange ? `${sourceTime(selectedRange.startMs)} – ${sourceTime(selectedRange.endMs)}` : '请先点选商品段';
  const historical = selectedRange?.kind === 'historical-analysis';
  const needsTranscript = !!state && state.transcription.status !== 'complete';
  const reviewTranscript = needsTranscript && !!(state?.transcription.boundaryReview || state?.transcription.code === 'ASR_BOUNDARY_REVIEW');
  const transcribing = state?.transcription.status === 'running';
  const actionLabel = historical ? '历史结果' : runningAnalysis ? '分析中…' : selectedComplete ? '重新分析' : starting ? '提交中…' : selectedAnalysis?.status === 'failed' ? '重试分析' : '分析';
  const action = <button type="button" className="min-h-9 flex-1 rounded-md border border-[var(--accent)]/60 bg-[var(--accent)]/20 px-4 py-2 text-[12px] font-medium transition duration-150 hover:bg-[var(--accent)]/30 active:scale-[.98] disabled:opacity-50" aria-label={`${actionLabel} ${rangeLabel}`} title={needsTranscript ? '请先完成整条原视频的转写' : `${selectedComplete ? '重新分析此商品段' : '仅分析此商品段'}：${rangeLabel}`} disabled={historical || !state || needsTranscript || analyzing || preparation?.busy || !!confirm || !selectedRange} onClick={() => setConfirm(selectedComplete ? 'rerun' : 'analyze')}>{actionLabel}</button>;
  const source = sources.find(item => item.id === sourceId);
  const preparing = transcribing || preparation?.preparation?.status === 'running' || preparation?.discovery.status === 'running';
  const reviewDiscovery = !needsTranscript && preparation?.needsReview;
  const prepared = !needsTranscript && preparation?.discoveryReady && !reviewDiscovery;
  const transcriptLabel = reviewTranscript ? '核对转写' : reviewDiscovery ? '核对拆品' : transcribing ? '转写中…' : preparing ? '拆品中…' : needsTranscript ? state?.transcription.status === 'failed' ? '重试转写' : '转写' : '继续拆品';
  const transcription = source && <section aria-label="原视频转写" className="-order-2 shrink-0 space-y-2 border-b border-[var(--border)] px-3 py-3 transition duration-150">
    <div className="flex items-center justify-between gap-2"><strong>原视频</strong>{prepared && !preparing && <span className="text-[11px] text-[var(--text-muted)]">商品已准备好</span>}</div>
    <p className="break-all text-[11px] text-[var(--text-muted)]" title={source.assetPath}>{source.assetPath.split(/[\\/]/).at(-1)} · 整条视频{source.durationMs ? ` ${sourceTime(source.durationMs)}` : ''}</p>
    {state && preparation && (!prepared || preparing) && <button type="button" className="min-h-10 w-full rounded-md border border-blue-600 bg-blue-600 px-4 py-2 text-[13px] font-medium text-white transition duration-150 hover:bg-blue-700 active:scale-[.98] disabled:opacity-50" aria-label={`${transcriptLabel} ${source.assetPath}`} disabled={!!(analyzing || preparing || confirm)} onClick={() => { if (reviewTranscript) onReviewTranscript(); else if (reviewDiscovery) onReviewTranscript(true); else setConfirm('transcribe'); }}>{transcriptLabel}</button>}
    {state && !prepared && <p role="status" className="text-[11px] text-[var(--text-muted)]">{reviewTranscript ? '分段转写已完成，请核对交界处的字幕。' : reviewDiscovery ? '商品识别已完成，请核对与现有商品范围的差异。' : transcribing ? '正在转写整条视频，完成后保存字幕。' : preparing ? '正在识别商品，完成后显示商品列表。' : !needsTranscript ? '转写已完成，可分析已选范围；需要按商品分段时再拆品。' : '先将整条视频转成文字，完成后再选择分析或拆品。'}</p>}
    {state?.transcription.status === 'failed' && !reviewTranscript && state.transcription.error && <p role="alert" className="text-[11px] text-[var(--warn)]">{state.transcription.error}</p>}
    {transcribing && state?.transcription.progress && <p role="status" className="text-[11px]">{state.transcription.progress.phase === 'extracting' ? '正在准备音频' : '正在识别音频'} · 第 {state.transcription.progress.currentSegment}/{state.transcription.progress.totalSegments} 段 · 已完成 {state.transcription.progress.completedSegments} 段</p>}
    {!reviewTranscript && preparation?.preparation?.status === 'failed' && !(preparation.preparation.phase === 'transcription' && !needsTranscript) && <p role="alert" className="text-[11px] text-[var(--warn)]">{preparation.preparation.error}</p>}
  </section>;
  const feedback = <>
    {sourceId && !state && !error && <p className="mt-2 text-[10.5px] text-[var(--text-muted)]">正在读取任务状态…</p>}
    {runningAnalysis && <p role="status" className="mt-2 text-[11px] text-[var(--accent)]">分析中… · {runningAnalysis.rangeStartMs !== undefined && runningAnalysis.rangeEndMs !== undefined ? `${sourceTime(runningAnalysis.rangeStartMs)} – ${sourceTime(runningAnalysis.rangeEndMs)}` : '已提交范围'} · 切换查看范围不影响任务，请等待完成</p>}
    {historical && <p className="mt-2 text-[10.5px] text-[var(--text-muted)]">当前为保存的历史话术范围，可直接预览和选材；不代表当前商品切点。</p>}
    {error && <p role="alert" className="mt-2 text-red-400">{error} <button className={btn} onClick={() => setTick((n) => n + 1)}>重试读取</button></p>}
    {selectedAnalysis?.status === 'failed' && selectedAnalysis?.error && <p role="alert" className="mt-2 text-red-400">{selectedAnalysis?.error}</p>}
    {confirm && state && <ProductWorkflowConfirmation key={`${scope}:${confirm}`} projectId={projectId}
      request={{ sourceId, action: confirm === 'transcribe' ? needsTranscript ? 'transcription' : 'discovery' : 'analysis', ...(confirm === 'transcribe' && !needsTranscript ? { prepare: true } : {}), ...(confirm !== 'transcribe' && selectedRange ? { productId: selectedRange.productId, intervalId: selectedRange.id } : {}), rerun: confirm === 'rerun', retry: confirm === 'transcribe' ? needsTranscript ? state.transcription.status === 'failed' : preparation?.discovery.status === 'failed' : confirm !== 'rerun' && selectedAnalysis?.status === 'failed' }}
      onDone={requestFinished} onClose={() => { setConfirm(null); setTick(n => n + 1); }} />}
  </>;
  const details = <details className="text-[11px] text-[var(--text-muted)]">
      <summary className="cursor-pointer transition-colors hover:text-[var(--accent)]">分析详情</summary>
    {sources.length > 0 ? <select aria-label="分析来源视频" value={sourceId} disabled={starting || !!confirm} onChange={(e) => onSelectSource(e.target.value)} className="mt-2 w-full rounded bg-[var(--dock-pane)] p-1">{sources.map((s) => <option key={s.id} value={s.id}>{s.assetPath}</option>)}</select> : <p className="mt-2">请先选择有关联视频的商品。</p>}
    {sourceId && <label className="mt-2 block">文字分析范围<select aria-label="文字分析范围" value={selectedRange?.id ?? ''} disabled={starting || !!confirm || selectedAnalysis?.status === 'running'} onChange={e => onSelectRange(e.target.value)} className="mt-1 w-full rounded bg-[var(--dock-pane)] p-1"><option value="">{ranges.length ? '请选择一个范围' : '当前商品暂无已确认范围'}</option>{ranges.map(r => <option key={r.id} value={r.id}>{sourceTime(r.startMs)} – {sourceTime(r.endMs)}</option>)}</select><span className="mt-1 block text-[11px] text-[var(--text-muted)]">每次仅分析所选范围。</span></label>}
    {state && <>
      <p className="mt-2">转写：{status(state.transcription.status)}{state.transcription.error ? ` · ${state.transcription.error}` : ''}</p>
      {state.transcription.status === 'complete' && <p className="mt-1 text-[var(--text-muted)]">已保存转写，将复用现有结果。</p>}
      <p className="mt-2">文字分析：{status(selectedAnalysis?.status === 'complete' && !selectedComplete ? 'idle' : selectedAnalysis?.status ?? 'idle')}{selectedAnalysis?.error ? ` · ${selectedAnalysis?.error}` : ''}</p>
      {selectedAnalysis?.progress && <p className="mt-1 text-[10.5px] text-[var(--text-muted)]">已完成 {selectedAnalysis?.progress.completedWindows}/{selectedAnalysis?.progress.totalWindows} 段 · 复用 {selectedAnalysis?.progress.resumedWindows} 段 · 请求 {selectedAnalysis?.progress.requestAttempts} 次 · {Math.round(selectedAnalysis?.progress.elapsedMs / 1000)} 秒</p>}
      {selectedAnalysis?.status === 'failed' && <p className="mt-1 text-[10.5px] text-[var(--warn)]">显式重试会复用已完成分段；失败或提交不确定的分段再次请求可能计费。</p>}
      {state.transcription.segments.length > 0 && <details className="mt-2"><summary className="cursor-pointer">转写文本 · {state.transcription.segments.length} 条</summary><div className="mt-1 max-h-52 overflow-y-auto">{state.transcription.segments.map((s, i) => <button key={`${s.startMs}-${i}`} className="block w-full border-t border-[var(--border)] py-1 text-left" onClick={() => onLocate(sourceId, s.startMs)}><span className="text-[var(--text-muted)]">{sourceTime(s.startMs)} – {sourceTime(s.endMs)}</span><span className="block">{s.text}</span></button>)}</div></details>}
    </>}
  </details>;
  return children({ action, transcription, feedback, details });
}

export function ProductPanel(props: ProductPanelProps) {
  const [sharedOpen, setSharedOpen] = React.useState<SharedProjectOpen | null>(null);
  const [sharedError, setSharedError] = React.useState('');
  const [refresh, setRefresh] = React.useState(0);
  const [reading, setReading] = React.useState(false);
  const attempted = React.useRef(new Set<string>());
  const sourceId = props.analysis.sources.length === 1 ? props.analysis.sources[0]!.id : props.rangeSelection.sourceId;
  const identity = `${props.projectId}:${sourceId}`;
  const currentIdentity = React.useRef(identity); currentIdentity.current = identity;
  const updated = React.useRef(props.onAnalysisComplete); updated.current = props.onAnalysisComplete;
  const resume = async () => {
    setReading(true); setSharedError('');
    try {
      const report = await api.resumeSharedAnalyses(props.projectId, sourceId);
      if (currentIdentity.current !== identity) return;
      setSharedOpen(report);
      await updated.current();
    } catch (error) { if (currentIdentity.current === identity) setSharedError(error instanceof Error ? error.message : String(error)); }
    finally { if (currentIdentity.current === identity) setReading(false); }
  };
  React.useEffect(() => {
    const readReport = (event: Event) => {
      if ((event as CustomEvent<{ projectId?: string }>).detail?.projectId === props.projectId) setRefresh(value => value + 1);
    };
    window.addEventListener('refresh-product-analysis', readReport);
    return () => window.removeEventListener('refresh-product-analysis', readReport);
  }, [props.projectId]);
  React.useEffect(() => {
    let active = true;
    setSharedOpen(null); setSharedError(''); setReading(false);
    void api.sharedProjectOpen(props.projectId).then(async result => {
      if (!active) return;
      setSharedOpen(result.sharedRead);
      const key = `${props.projectId}:${sourceId}`;
      // Upgrade incomplete old readers using saved artifacts only. The server
      // preserves edits and never invokes ASR or the model through this route.
      if (result.sharedRead && result.sharedRead.readerRevision !== 3 && sourceId && !attempted.current.has(key)) {
        attempted.current.add(key);
        await resume();
      }
    }, error => {
      if (active) setSharedError(error instanceof Error ? error.message : String(error));
    });
    return () => { active = false; };
  }, [props.projectId, sourceId, refresh]);
  return <>
    {(sharedOpen || sharedError) && <div aria-label="已有分析读取状态" role="status" className="shrink-0 border-b border-[var(--border)] px-3 py-2 text-[11px] leading-relaxed text-[var(--text-muted)] transition duration-150">
      {sharedOpen && <p>{sharedOpen.status === 'ready' ? '已读取已有分析，可直接预览和选材' : sharedOpen.status === 'empty' ? '当前视频尚无已保存的共享分析' : sharedOpen.status === 'review-required' ? '已有分析需要核对，请查看素材与拆品记录' : '已有共享分析暂未读取，请检查连接或素材与拆品记录'}</p>}
      {sourceId && <button type="button" className={btn} disabled={reading} onClick={() => void resume()}>{reading ? '正在读取已有分析和方案…' : '刷新共享分析和方案（不重新分析）'}</button>}
      {sharedOpen?.warnings.map((warning, index) => <p key={index} className="mt-1 text-[var(--warn)]">{warning}</p>)}
      {sharedError && <p>读取已有分析状态失败：{sharedError} <button type="button" className={btn} onClick={() => setRefresh(value => value + 1)}>重试读取</button></p>}
    </div>}
    <ProductPanelContent key={props.selectedProductId ?? ''} {...props} />
  </>;
}

function ProductPanelContent({ files, currentSourcePath, analysis, selectedProductId, rangeSelection: selected, onRangeSelectionChange: setSelection, onSelectProduct, onSave, onLocate, onAddCandidate, onDragCandidate, onDragCandidateEnd, sharedAdd, projectId, onAnalysisComplete, candidateUnavailable, tag, onTagChange, canDragCandidate, onCompose, onReturnToProject }: ProductPanelProps) {
  const [error, setError] = React.useState('');
  const [renaming, setRenaming] = React.useState(false);
  const [transcriptRefresh, setTranscriptRefresh] = React.useState(0);
  const [transcriptReviewRequest, setTranscriptReviewRequest] = React.useState<{ sourceId: string; id: number; kind: 'transcript' | 'discovery' }>();
  const [productName, setProductName] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState('');
  const [showRecovered, setShowRecovered] = React.useState(() => { const item = analysis.products.find(p => p.id === selectedProductId); return !!item && isRecoveredProduct(item); });
  // Historical analysis may extend beyond today's lecture boundary. Show all saved
  // candidates without changing the selected lecture or its source times.
  const candidatesSection = React.useRef<HTMLElement>(null);
  const [candidateScope, setCandidateScope] = React.useState<'range' | 'product'>('product');
  const [draggedCandidate, setDraggedCandidate] = React.useState<string>();
  const product = analysis.products.find((p) => p.id === selectedProductId);
  const ranges = [...productResultRanges(analysis, selectedProductId ?? '')].sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.startMs - b.startMs);
  const selectRange = (range: ProductInterval) => {
    setSelection({ sourceId: range.sourceId, intervalId: range.id });
    onLocate(range.sourceId, range.startMs);
  };
  const selectSource = (sourceId: string) => {
    const range = ranges.find(range => range.sourceId === sourceId);
    if (range) selectRange(range);
    else { setSelection({ sourceId, intervalId: '' }); onLocate(sourceId, 0); }
  };
  const name = (id: string) => analysis.sources.find((s) => s.id === id)?.assetPath ?? '来源不可用';
  const saveName = async () => {
    if (!product || busy) return;
    const nextName = productName.trim();
    if (!nextName) { setError('商品名称不能为空。'); return; }
    if (nextName === product.name) { setRenaming(false); setError(''); return; }
    setError(''); setNotice(''); setBusy(true);
    try {
      await onSave(applyProductEdit(analysis, { type: 'rename', productId: product.id, name: nextName }));
      if (!isRecoveredProduct({ ...product, name: nextName })) setShowRecovered(false);
      setRenaming(false); setNotice('已保存');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const selectedRange = ranges.find(range => range.id === selected.intervalId && range.sourceId === selected.sourceId);
  const savedRange = selectedRange && savedStructureRange(analysis, selectedRange);
  const analysisRange = productAnalysisRange(analysis, selectedProductId ?? '', selectedRange);
  const currentRanges = analysis.intervals.filter(r => r.productId === selectedProductId && !r.sharedLayoutHidden);
  const analysisRanges = currentRanges.length ? currentRanges : ranges;
  const selectedIds = new Set([selectedRange?.id, savedRange?.id, ...(selectedRange?.joinedScopeIds ?? []), ...(savedRange?.joinedScopeIds ?? [])]);
  const allCandidates = product ? productResultCandidates(analysis, product.id) : [];
  const candidates = allCandidates.filter(c => candidateScope === 'product' || c.sourceId === selected.sourceId && selectedIds.has(c.intervalId));
  const recovered = !!savedRange && (savedRange.id !== selectedRange?.id || savedRange.kind === 'historical-analysis');
  const showSavedAnalysis = () => { setCandidateScope('product'); onTagChange('全部'); candidatesSection.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); };
  const activeTag = displayStructureTag(tag);
  const filtered = candidates.filter((c) => hasStructureTag(c.tags, tag));
  const candidateCounts = React.useMemo(() => new Map(analysis.products.map(product => [product.id, productResultCandidates(analysis, product.id).length])), [analysis]);
  const status = (item: ProductAnalysis['products'][number]) => {
    const count = candidateCounts.get(item.id) ?? 0;
    return count ? `${count} 个候选` : item.sourceIds.length ? '未分析或无候选' : '未关联视频';
  };
  const isDemo = candidates.some((candidate) => candidate.origin === 'demo-data');
  const products = React.useMemo(() => visibleProducts(analysis), [analysis]);
  const pendingProducts = products.filter(isRecoveredProduct);
  const shownProducts = showRecovered ? pendingProducts : products.filter(p => !isRecoveredProduct(p));
  const toggleRecovered = () => {
    if (showRecovered && product && isRecoveredProduct(product)) { const first = products.find(p => !isRecoveredProduct(p)); if (first) onSelectProduct(first.id); }
    setShowRecovered(value => !value);
  };
  const dailyEntry = !!analysis.sources.length && !analysis.intervals.length && !analysis.candidates.length;
  return <LiveAnalysis refreshKey={transcriptRefresh} projectId={projectId} sources={analysis.sources.filter((s) => product?.sourceIds.includes(s.id))} ranges={analysisRanges} sourceId={analysisRange?.sourceId ?? selected.sourceId} intervalId={analysisRange?.id ?? ''} onSelectSource={selectSource} onSelectRange={id => { const range = ranges.find(range => range.id === id); if (range) selectRange(range); else setSelection({ sourceId: selected.sourceId, intervalId: '' }); }} onLocate={onLocate} onAnalysisComplete={onAnalysisComplete} onWorkflowStarted={() => setTranscriptRefresh(value => value + 1)} onReviewTranscript={(discovery = false) => setTranscriptReviewRequest(previous => ({ sourceId: selected.sourceId, id: (previous?.id ?? 0) + 1, kind: discovery ? 'discovery' : 'transcript' }))}>{({ action, transcription, feedback, details }) => <div className="flex min-h-0 flex-1 flex-col overflow-y-auto text-[12px] text-[var(--text)]">
    {!onReturnToProject && transcription}
    <div className="shrink-0 border-b border-[var(--border)] px-3 pb-3 pt-3">
      <div className="mb-2 flex flex-wrap items-center gap-2"><strong className="flex-1">{showRecovered ? '待确认的已有分析' : '商品'}</strong>{pendingProducts.length > 0 && <button type="button" className={btn} aria-expanded={showRecovered} onClick={toggleRecovered}>{showRecovered ? '返回商品列表' : `待确认的已有分析 ${pendingProducts.length}`}</button>}</div>{showRecovered && <p className="mb-2 text-[11px] text-[var(--text-muted)]">这些原分析尚未对应到当前商品，内容已保留，可查看原话后确认归属。</p>}
      <VirtualList items={shownProducts} itemKey={p => p.id} estimateHeight={p => p.id === selectedProductId ? 160 : 100} label="商品列表" maxHeight={320} pinnedKey={selectedProductId ?? undefined} revealKey={selectedProductId ?? undefined} renderItem={p => {
        const cardSelected = p.id === selectedProductId;
        const summary = productRangeSummary(analysis, p.id);
        const displayName = isRecoveredProduct(p) ? '已有分析（商品待确认）' : p.name;
        const original = isRecoveredProduct(p) ? [...analysis.intervals, ...(analysis.scopes ?? [])].find(range => range.productId === p.id) : undefined;
        return <div key={p.id} data-product-card={p.id} className={`flex min-h-24 min-w-0 shrink-0 flex-col gap-3 rounded-lg border p-3 transition duration-200 motion-safe:animate-[daocut-rise_180ms_ease-out] ${cardSelected ? 'border-[var(--accent)] bg-[var(--accent)]/10' : 'border-[var(--border)] bg-[var(--surface)] hover:border-[var(--accent)]/40 hover:bg-[var(--bg-hover)]'}`}>
          {cardSelected && renaming ? <>
            <input autoFocus aria-label="商品名称" value={productName} disabled={busy} onChange={(e) => setProductName(e.target.value)} onKeyDown={(e) => { if (e.nativeEvent.isComposing || e.keyCode === 229) return; if (e.key === 'Enter') { e.preventDefault(); void saveName(); } else if (e.key === 'Escape') { setRenaming(false); setError(''); } }} className="min-h-9 w-full min-w-0 rounded-md border border-[var(--accent)] bg-[var(--dock-pane)] px-2 py-1.5 text-[13px] outline-none" />
            <div className="flex gap-2"><button type="button" className={`${btn} min-h-9 flex-1`} disabled={busy} onClick={() => void saveName()}>保存</button>
            <button type="button" className={`${btn} min-h-9 flex-1`} disabled={busy} onClick={() => { setRenaming(false); setError(''); }}>取消</button></div>
            <details className="border-t border-[var(--border)] pt-2 text-[11px] text-[var(--text-muted)]"><summary className="cursor-pointer transition-colors hover:text-[var(--accent)]">归属与人工修正</summary>
              <ProductRanges analysis={analysis} productId={selectedProductId} selectedIntervalId={selected.intervalId} onSelectRange={selectRange} onSave={onSave} onLocate={onLocate} />
            </details>
          </> : <>
            <button type="button" aria-pressed={cardSelected} className="flex w-full min-w-0 flex-1 flex-col justify-center gap-2.5 text-left transition active:scale-[.99]" onClick={() => onSelectProduct(p.id)}>
              <span className="w-full break-words text-[14px] font-medium leading-5" title={`${displayName} · ${p.sourceIds.length} 个视频 · ${status(p)}`}>{displayName}</span>{original && <span className="text-[11px] text-[var(--text-muted)]">{sourceTime(original.startMs)} – {sourceTime(original.endMs)}</span>}
              <span className="flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px] leading-4 text-[var(--text-muted)]"><span>{summary.count ? `${summary.count} 段讲解` : '请选择讲解范围'}</span>{summary.count > 0 && <span className="tabular-nums">共 {sourceTime(summary.totalMs)}</span>}</span>
              {!!candidateCounts.get(p.id) && <span className="text-[11px] text-[var(--accent)]">{candidateCounts.get(p.id)} 条话术</span>}
            </button>

            {cardSelected && <div className="flex flex-wrap items-center gap-2 border-t border-[var(--accent)]/15 pt-2.5">{onReturnToProject ? <button type="button" className={btn} onClick={onReturnToProject}>返回工程分析</button> : recovered && allCandidates.length && !analysisRange?.joinedScopeIds?.length ? <button type="button" className={`${btn} min-h-9 flex-1`} onClick={showSavedAnalysis}>查看已有分析</button> : action}{onCompose && <button type="button" className={`${btn} min-h-9 rounded-md px-3 text-[12px]`} disabled={!analysisRange} onClick={() => { const range = analysisRange; if (range) { const saved = savedStructureRange(analysis, range); onCompose({ sourceId: saved.sourceId, productId: saved.productId, intervalId: saved.id, startMs: saved.startMs, endMs: saved.endMs }); } }}>拼结构</button>}<button type="button" className={`${btn} min-h-9 shrink-0 rounded-md px-3 text-[12px]`} disabled={busy || !!onReturnToProject} aria-label={`编辑商品名称：${p.name}`} onClick={() => { setProductName(p.name); setError(''); setRenaming(true); }}>编辑</button></div>}
          </>}
        </div>;
      }} />
      {feedback}
    </div>
    {notice && <p role="status" className="shrink-0 mx-3 my-2 text-[var(--text-muted)]">{notice}</p>}
    {error && <p role="alert" className="shrink-0 mx-3 my-2 text-red-400">{error}</p>}
    {!product ? <p className="mt-3 text-[var(--text-muted)]">选择商品开始整理</p> : <>
      {sharedAdd && <details className="order-3 shrink-0 border-t border-[var(--border)] px-3 py-2"><summary className="cursor-pointer text-[11.5px] text-[var(--text-muted)]">添加视频 / 配置共享素材</summary><div className="mt-2">{sharedAdd}</div></details>}
      <section ref={candidatesSection} className="order-2 flex min-h-[180px] shrink-0 flex-col border-t border-[var(--border)] px-3 py-2.5" aria-label="候选片段">
        <div className="mb-1.5 flex items-center"><h3 className="flex-1 font-medium">候选片段</h3><span className="text-[10.5px] text-[var(--text-muted)]">{filtered.length} / {candidates.length}</span></div>
        <div className="mb-2 flex flex-wrap gap-1" aria-label="候选显示范围"><button type="button" aria-pressed={candidateScope === 'range'} className={`${btn} ${candidateScope === 'range' ? 'border-[var(--accent)] text-[var(--accent)]' : ''}`} onClick={() => setCandidateScope('range')}>当前段</button><button type="button" aria-pressed={candidateScope === 'product'} className={`${btn} ${candidateScope === 'product' ? 'border-[var(--accent)] text-[var(--accent)]' : ''}`} onClick={() => setCandidateScope('product')}>该商品全部讲解</button></div>
        {ranges.filter(range => range.kind === 'historical-analysis' || (range.kind === 'confirmed-inspection' && analysis.intervals.some(interval => interval.joinedScopeIds?.includes(range.id)))).map(range => <div key={range.id} className="mb-2 flex gap-1 transition duration-150"><button className={`${btn} min-w-0 flex-1 text-left`} aria-pressed={selected.intervalId === range.id} onClick={() => selectRange(range)}>{range.kind === 'historical-analysis' ? '历史话术' : '原分析范围'} · {sourceTime(range.startMs)} – {sourceTime(range.endMs)}</button>{onCompose && <button className={btn} onClick={() => { const saved = savedStructureRange(analysis, range); onCompose({ sourceId: saved.sourceId, productId: saved.productId, intervalId: saved.id, startMs: saved.startMs, endMs: saved.endMs }, false); }}>查看旧结构</button>}</div>)}
        <p className="mb-2 text-[10.5px] text-[var(--text-muted)]">按住片段拖到下方成片时间线</p>
        <div className="mb-2 flex flex-wrap gap-1">{['全部', ...tags].map((t) => { const count = t === '全部' ? candidates.length : candidates.filter((candidate) => hasStructureTag(candidate.tags, t)).length; return <button key={t} aria-pressed={activeTag === t} className={`${btn} ${activeTag === t ? 'ring-2 ring-[var(--accent)] ring-offset-1 ring-offset-[var(--surface)]' : 'text-[var(--text-muted)]'}`} style={t === '全部' || activeTag !== t ? undefined : { backgroundColor: structureColor(t).bg, color: structureColor(t).text, borderColor: structureColor(t).border }} onClick={() => onTagChange(t)}>{t} {count}</button>; })}</div>
        {isDemo ? <p className="mb-2 rounded border border-[var(--accent)]/30 bg-[var(--accent)]/10 px-2 py-1.5 text-[10.5px] leading-relaxed text-[var(--text-muted)]">演示数据：原话、标签和区间均为合成示例，不是实际视频分析。</p> : null}
        {!candidates.length ? <p className="text-[var(--text-muted)]">{candidateScope === 'range' ? '当前段暂无候选片段。' : '当前商品暂无候选片段。'}</p> : !filtered.length ? <p className="text-[var(--text-muted)]">此标签暂无候选片段。</p> : <VirtualList key={`${selected.sourceId}:${selected.intervalId}:${candidateScope}:${tag}`} items={filtered} itemKey={c => c.id} estimateHeight={() => 160} label="结构候选列表" maxHeight={360} gap={6} pinnedKey={draggedCandidate} renderItem={c => <article data-candidate-card={c.id} draggable={canDragCandidate(c.id)} onDragStart={(event) => { setDraggedCandidate(c.id); onDragCandidate(c.id, event); }} onDragEnd={() => { setDraggedCandidate(undefined); onDragCandidateEnd(); }} className="rounded border border-[var(--border)] bg-[var(--surface)] p-2"><button className="block w-full text-left" onClick={() => onLocate(c.sourceId, c.startMs, c.id)}><span className="block leading-relaxed">{c.text || '候选片段'}</span><span className="mt-1 block truncate text-[10.5px] text-[var(--text-muted)]" title={name(c.sourceId)}>{name(c.sourceId)} · {sourceTime(c.startMs)} – {sourceTime(c.endMs)}</span></button>{candidateUnavailable(c) && <p className="mt-1 text-[10.5px] text-[var(--warn)]">话术状态尚未核对，暂不可加入成片</p>}<div className="mt-1.5 flex flex-wrap gap-1">{displayStructureTags(c.tags).map((item) => <span key={item} className="rounded border px-1.5 py-0.5 text-[10px]" style={{ backgroundColor: structureColor(item).bg, color: structureColor(item).text, borderColor: structureColor(item).border }}>{item}</span>)}</div><div className="mt-2 flex gap-1"><button className={`${btn} shrink-0 whitespace-nowrap`} onClick={() => onLocate(c.sourceId, c.startMs, c.id, true)}>预览</button><button className={`${btn} shrink-0 whitespace-nowrap`} disabled={candidateUnavailable(c)} onClick={() => onAddCandidate(c.id)}>加入成片</button></div></article>} />}
      </section>
    </>}
    <div className="order-3 shrink-0 border-t border-[var(--border)] px-3 py-2">{onReturnToProject ? <p className="text-[11px] text-[var(--text-muted)]">这里沿用原工程的分析。商品范围和分析在原工程管理，当前个人草稿单独保存。</p> : details}</div>
    {!onReturnToProject && <div className="order-3 shrink-0 px-3 py-2 transition-all"><ProductDiscovery primaryAction={!transcription} refreshKey={transcriptRefresh} projectId={projectId} files={files} currentSourcePath={currentSourcePath} analysis={analysis} dailyEntry={dailyEntry} transcriptReviewRequest={transcriptReviewRequest} onApplied={async () => { await onAnalysisComplete(); setTranscriptRefresh(value => value + 1); }} onLocate={onLocate} /></div>}
  </div>}</LiveAnalysis>;
}
