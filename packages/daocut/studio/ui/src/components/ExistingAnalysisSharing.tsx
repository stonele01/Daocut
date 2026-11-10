import { displayStructureTags } from '@/lib/product-structure-tags';
import React from 'react';
import { api, type SharedMediaLibrary } from '@/api';
import { readProductAnalysis, sourceTime, type Product } from '@/lib/product-analysis';
import type { ExistingResult, ExistingPublicationPlan, SharedHistoricalResult, SharedHistoricalPreview } from '@/lib/existing-analysis-types';

const button = 'rounded border border-[var(--border)] px-2 py-1 text-[11px] transition duration-150 hover:bg-[var(--bg-hover)] active:scale-95 disabled:opacity-40';
const names = { transcription: '转写原始结果', discovery: '商品识别原始结果', analysis: '话术原始结果' };
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const rangeOf = (result: { scope?: { startMs: number; endMs: number } }) => result.scope ? `${sourceTime(result.scope.startMs)} – ${sourceTime(result.scope.endMs)}` : '整场';

/** Publishing saved artifacts is deliberately separate from the paid workflow API. */
export function ExistingAnalysisSharing({ projectId, sourceId, sourcePath, durationMs, refreshKey = 0, onChanged, onLocate }: {
  projectId: string; sourceId: string; sourcePath: string; durationMs: number | null; refreshKey?: string | number; onChanged: () => Promise<void>;
  onLocate: (sourceId: string, ms: number, candidateId?: string, play?: boolean) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [results, setResults] = React.useState<ExistingResult[]>([]);
  const [history, setHistory] = React.useState<SharedHistoricalResult[] | null>(null);
  const [products, setProducts] = React.useState<Product[]>([]);
  const [warnings, setWarnings] = React.useState<string[]>([]);
  const [plan, setPlan] = React.useState<ExistingPublicationPlan | null>(null);
  const [retry, setRetry] = React.useState<ExistingPublicationPlan | null>(null);
  const [preview, setPreview] = React.useState<SharedHistoricalPreview | null>(null);
  const [productId, setProductId] = React.useState('');
  const [productName, setProductName] = React.useState('');
  const [assetPath, setAssetPath] = React.useState('');
  const [libraries, setLibraries] = React.useState<SharedMediaLibrary[]>([]);
  const [libraryId, setLibraryId] = React.useState('');
  const [videoPath, setVideoPath] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [message, setMessage] = React.useState('');
  const submitting = React.useRef(false);
  const active = React.useRef(true);
  const scope = JSON.stringify([projectId, sourceId, sourcePath, durationMs]);
  const currentScope = React.useRef(scope); currentScope.current = scope;
  const loadSerial = React.useRef(0);
  const isCurrent = () => active.current && currentScope.current === scope;
  React.useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  React.useEffect(() => {
    loadSerial.current++;
    submitting.current = false;
    setBusy(false); setResults([]); setHistory(null); setProducts([]); setWarnings([]);
    setPlan(null); setRetry(null); setPreview(null); setProductId(''); setProductName('');
    setLibraryId(''); setVideoPath(''); setError(''); setMessage('');
  }, [scope]);
  const perform = async (work: () => Promise<void>) => {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setError(''); setMessage('');
    try { await work(); }
    catch (reason) { if (isCurrent()) setError(messageOf(reason)); }
    finally { if (isCurrent()) { submitting.current = false; setBusy(false); } }
  };
  const loadHistory = async () => {
    if (durationMs == null || durationMs <= 0) { if (isCurrent()) setHistory(null); return; }
    const serial = ++loadSerial.current;
    const next = await api.sharedAnalysisHistory(projectId, sourceId);
    if (!isCurrent() || serial !== loadSerial.current) return;
    setHistory(next.results); setWarnings(next.warnings ?? []);
  };
  const load = async (withHistory = false) => {
    const serial = ++loadSerial.current;
    const [saved, current, prefs] = await Promise.all([api.existingAnalysisResults(projectId, sourceId), readProductAnalysis(projectId), api.prefs()]);
    if (!isCurrent() || serial !== loadSerial.current) return;
    setResults(saved.results); setWarnings(saved.warnings ?? []);
    setProducts(current.analysis.products.filter(product => product.sourceIds.includes(sourceId)));
    setAssetPath(current.analysis.sources.find(source => source.id === sourceId)?.assetPath ?? '');
    setLibraries(prefs.sharedMediaLibraries);
    if (withHistory && prefs.sharedAnalysis.enabled) await loadHistory();
  };
  React.useEffect(() => {
    let cancelled = false;
    if (open) void load(true).catch(reason => { if (!cancelled && isCurrent()) setError(messageOf(reason)); });
    return () => { cancelled = true; loadSerial.current++; };
  }, [open, scope, refreshKey]);
  const publish = (frozen: ExistingPublicationPlan) => perform(async () => {
    setPlan(null); setRetry(frozen);
    await api.publishExistingAnalysis(projectId, frozen);
    if (isCurrent()) { setRetry(null); setMessage('已有结果已共享，未发送模型请求'); }
  });
  const inspect = (result: SharedHistoricalResult) => perform(async () => {
    const next = await api.previewSharedHistory(projectId, { sourceId, taskKey: result.taskKey, resultSha: result.resultSha });
    if (isCurrent()) { setPreview(next); setProductId(''); setProductName(''); }
  });
  const adopt = () => perform(async () => {
    if (!preview || !preview.canImport || (preview.action === 'analysis' && (!productId || (productId === '__new' && !productName.trim())))) return;
    const result = await api.importSharedHistory(projectId, { sourceId, taskKey: preview.taskKey, resultSha: preview.resultSha, confirmed: true,
      ...(preview.action !== 'analysis' ? {} : productId === '__new' ? { productName: productName.trim() } : { productId }) });
    if (!isCurrent()) return;
    await onChanged();
    if (isCurrent()) {
      setMessage(result.needsReview ? result.reason || '结果已保存，请核对后采用；个人修改保留' : preview.action === 'analysis' ? '历史结果已导入，商品讲解边界和成片未改变' : '已有结果已导入，个人修改与成片保留');
      setPreview(null);
    }
  });
  return <section aria-label="已有分析结果共享" className="space-y-2 text-[11px] transition-all duration-150">
    <button type="button" className={button} disabled={busy} aria-expanded={open} onClick={() => setOpen(value => !value)}>发布已有分析结果</button>
    <div className={`grid transition-[grid-template-rows,opacity] duration-150 ${open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`} inert={!open}>
      <div className="min-h-0 overflow-hidden"><div className="space-y-2 rounded border border-[var(--border)] p-2">
        <p>共享已保存的 AI 底稿。个人商品调整、字幕修正、取用和成片不共享。</p>
        <details className="space-y-2"><summary className="cursor-pointer transition-colors hover:text-[var(--accent)]">关联已有本机视频与共享原片</summary>
          <p className="break-all">本机视频：{assetPath}</p><p>选择同一份共享原片。将完整比对两份内容，只保存关联，不搬动视频。</p>
          <label className="block">原片所在素材库<select className="mt-1 w-full rounded bg-[var(--dock-pane)] p-1" value={libraryId} disabled={busy} onChange={event => setLibraryId(event.target.value)}><option value="">请选择素材库</option>{libraries.map(library => <option key={library.id} value={library.id}>{library.name}</option>)}</select></label>
          <label className="block">共享原片路径<input className="mt-1 w-full rounded bg-[var(--dock-pane)] p-1" value={videoPath} disabled={busy} placeholder="素材库内相对路径或完整路径" onChange={event => setVideoPath(event.target.value)} /></label>
          {!libraries.length && <p>请先在现有素材库设置中配置共享位置。</p>}
          <button className={button} disabled={busy || !assetPath || !libraryId || !videoPath.trim()} onClick={() => void perform(async () => { await api.bindSharedMediaCopy(projectId, { assetPath, libraryId, videoPath: videoPath.trim(), confirmed: true }); if (isCurrent()) { setPlan(null); setRetry(null); setMessage('原片内容一致，关联已保存在本机'); await loadHistory(); } })}>核对内容并关联</button>
        </details>
        <div className="flex flex-wrap gap-1"><button className={button} disabled={busy} onClick={() => void perform(() => load(true))}>重新读取已有结果</button><button className={button} disabled={busy || durationMs == null || durationMs <= 0} onClick={() => void perform(loadHistory)}>查看同事已有结果</button></div>
        {(durationMs == null || durationMs <= 0) && <p role="status">视频信息尚未准备好，完成后会自动读取已有共享结果。</p>}
        {busy && <p role="status">正在读取或保存已有结果…</p>}
        {warnings.map((text, i) => <p key={i} className="text-[var(--warn)]">{text}</p>)}
        {!busy && !results.length && <p>当前没有可发布的完整原始结果。</p>}
        {results.map((result, i) => <div key={`${result.action}:${result.runId}:${i}`} className="space-y-1 border-t border-[var(--border)] pt-2">
          <p>{names[result.action]} · {rangeOf(result)}{result.count === undefined ? '' : ` · ${result.count} 条`}</p>
          {result.reason && <p className="text-[var(--warn)]">{result.reason}</p>}
          <button type="button" className={button} disabled={busy || !result.canPublish} onClick={() => void perform(async () => { const next = await api.existingPublicationPlan(projectId, { sourceId, action: result.action, runId: result.runId, intervalId: result.intervalId }); if (isCurrent()) { setPlan(next); setRetry(null); } })}>查看发布清单</button>
        </div>)}
        {plan && <div role="dialog" aria-label="确认发布已有结果" className="space-y-2 rounded border border-[var(--accent)] p-2 animate-in fade-in duration-150">
          <p>{names[plan.action]} · {rangeOf(plan)}{plan.count === undefined ? '' : ` · ${plan.count} 条`}</p>
          <p>新增转写和模型请求：0 次</p><p>共享结果目录：</p><p className="break-all">{plan.target.root}</p>
          {plan.action === 'transcription' && <p>共享原始分段文字和时间，可能含接缝重复。本机字幕修正不共享，导入后可在软件内核对接缝。</p>}
          <p className="break-all">原片标识 {plan.source.sha256.slice(0, 16)} · {plan.provenance.model || '模型来源未确认'}</p>
          {plan.provenance.warning && <p className="text-[var(--warn)]">{plan.provenance.warning}</p>}
          {(plan.warnings ?? []).map((text, i) => <p key={i} className="text-[var(--warn)]">{text}</p>)}
          {plan.reason && <p>{plan.reason}</p>}
          <div className="flex gap-1"><button className={button} disabled={busy || !plan.canPublish} onClick={() => void publish(plan)}>确认发布</button><button className={button} disabled={busy} onClick={() => setPlan(null)}>暂不发布</button></div>
        </div>}
        {retry && !busy && <button className={button} onClick={() => void publish(retry)}>仅重试保存此结果</button>}
        {history && <div className="space-y-2 border-t border-[var(--border)] pt-2"><p>同事已保存的历史版本</p>{!history.length && <p>尚无可读取的共享结果。</p>}{history.map(result => <div key={`${result.taskKey}:${result.resultSha}`} className="space-y-1"><p>{names[result.action]} · {rangeOf(result)}{result.count === undefined ? '' : ` · ${result.count} 条`}</p><button className={button} disabled={busy} onClick={() => void inspect(result)}>查看历史结果</button></div>)}</div>}
        {preview && <section aria-label="历史结果预览" className="space-y-2 rounded border border-[var(--border)] p-2 animate-in fade-in duration-150">
          <p>{names[preview.action]} · {rangeOf(preview)}</p>
          {preview.action === 'transcription' && <p>这是原始分段转写，不包含对方的本机字幕修正。</p>}
          <p>按当时分析范围保留完整结果。导入话术只新增历史分析范围，不改变商品讲解边界。</p>
          {preview.provenance?.warning && <p className="text-[var(--warn)]">{preview.provenance.warning}</p>}
          {(preview.warnings ?? []).map((text, i) => <p key={i} className="text-[var(--warn)]">{text}</p>)}
          {preview.reason && <p>{preview.reason}</p>}
          {preview.candidates && <div className="max-h-64 space-y-2 overflow-y-auto">{preview.candidates.map((candidate, i) => <button key={i} className="block w-full border-t border-[var(--border)] py-1 text-left transition hover:text-[var(--accent)] active:scale-[.99]" onClick={() => onLocate(sourceId, candidate.startMs)}><span className="block">{candidate.text}</span><span className="text-[var(--text-muted)]">{sourceTime(candidate.startMs)} – {sourceTime(candidate.endMs)} · {displayStructureTags(candidate.tags).join('、')}</span></button>)}</div>}
          {preview.proposal && <p>商品：{preview.proposal.products.map(product => product.name).join('、')} · {preview.proposal.intervals.length} 个范围。导入后仍需核对并采用。</p>}
          {preview.action === 'analysis' && <><label className="block">关联本机商品<select aria-label="关联本机商品" className="mt-1 w-full rounded bg-[var(--dock-pane)] p-1" value={productId} disabled={busy} onChange={event => setProductId(event.target.value)}><option value="">请选择，不自动归属</option>{products.map(product => <option key={product.id} value={product.id}>{product.name}</option>)}<option value="__new">新建本机商品…</option></select></label>{productId === '__new' && <label className="block">本机商品名称<input className="mt-1 w-full rounded bg-[var(--dock-pane)] p-1" value={productName} disabled={busy} onChange={event => setProductName(event.target.value)} /></label>}</>}
          <button type="button" className={button} disabled={busy || !preview.canImport || (preview.action === 'analysis' && (!productId || (productId === '__new' && !productName.trim())))} onClick={() => void adopt()}>{preview.action === 'analysis' ? '导入为历史分析范围' : '导入已有结果'}</button>
        </section>}
        {message && <p role="status">{message}</p>}{error && <p role="alert" className="text-red-400">{error}</p>}
      </div></div>
    </div>
  </section>;
}
