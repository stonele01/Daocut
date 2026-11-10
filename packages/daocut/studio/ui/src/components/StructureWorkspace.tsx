import * as React from 'react';
import { ArrowUpRight, ListVideo, Play, X } from 'lucide-react';
import { api } from '@/api';
import { useHostPanel } from '@/lib/host';
import { groupStructurePlans, structureGroupLabel, structureRole, type StructurePlan, type StructurePlansState, type StructureScope, type StructureWorkspaceState } from '@/lib/structure-workspace';
import { sourceTime } from '@/lib/product-analysis';
import { planLetter, structureDraftLabel, structurePlanCard } from '@/lib/structure-plan-card';
import { ProjectView } from './ProjectView';
import { VirtualList } from './VirtualList';
import { StructureExportBatches } from './StructureExportBatches';
import { selectedStructurePlanIds, toggleStructurePlan, type StructureBatchExportSelection, type StructureBatchExportOptions } from '@/lib/structure-export-selection';
import { mediaReviewPresentation } from '@/lib/product-media-review';
import { ProductVisualReviewDetails } from './ProductVisualReview';

export interface StructureEditorBridge {
  ownerId: string; scope: StructureScope | null; rightWidth: number; preview: StructurePlan | null; previewFolder: string;
  onScope: (scope: StructureScope | null) => void; onCompose: (scope: StructureScope) => void;
  onClosePreview: () => void; onShowPlans: () => void; registerSave: (save: () => Promise<void>) => () => void;
  onReturnToProject: () => void;
  draftLabel?: string;
  batchExport?: StructureBatchExportSelection;
}
const button = 'rounded border border-[var(--border)] px-2 py-1 text-[12px] transition duration-150 hover:bg-[var(--bg-hover)] active:scale-95 disabled:opacity-40';
const scopeKey = (scope: StructureScope | null) => scope ? `${scope.sourceId}:${scope.productId}:${scope.intervalId}:${scope.startMs ?? ''}:${scope.endMs ?? ''}` : '';

export function StructureWorkspace({ projectId, onProject, onLeave }: { projectId: string; onProject: (id: string) => void; onLeave: () => void }) {
  const [workspace, setWorkspace] = React.useState<StructureWorkspaceState | null>(null);
  const [scope, setScope] = React.useState<StructureScope | null>(null);
  const currentScope = React.useRef(scope); currentScope.current = scope;
  const [plans, setPlans] = React.useState<StructurePlansState | null>(null);
  const [preview, setPreview] = React.useState<StructurePlan | null>(null);
  const [folder, setFolder] = React.useState('');
  const [projectTitle, setProjectTitle] = React.useState('结构视频');
  const [error, setError] = React.useState(''), [working, setWorking] = React.useState(false), [switching, setSwitching] = React.useState(false);
  const [plansOpen, setPlansOpen] = React.useState(true);
  const [group, setGroup] = React.useState('');
  const [selectedPlans, setSelectedPlans] = React.useState<Set<string>>(() => new Set());
  const [batchRevision, setBatchRevision] = React.useState(0);
  const [batchPreparing, setBatchPreparing] = React.useState(false);
  const listContainer = React.useRef<HTMLDivElement>(null);
  const [listHeight, setListHeight] = React.useState(300);
  const pendingExport = React.useRef<{ signature: string; requestId: string } | null>(null);
  const host = useHostPanel();
  // The existing Layout menu owns the host chat. Preserve its saved state on entry;
  // only explicitly opening plans switches away from it, without remounting the chat.
  const plansVisible = plansOpen && !host?.open;
  const save = React.useRef<() => Promise<void>>(async () => {});
  const active = workspace?.activeProjectId ?? projectId;
  const request = React.useRef(0), generation = React.useRef(0);
  const switchLock = React.useRef(false);
  const hostSet = React.useRef(host?.setOpen); hostSet.current = host?.setOpen;
  const registerSave = React.useCallback((next: () => Promise<void>) => { save.current = next; return () => { if (save.current === next) save.current = async () => {}; }; }, []);
  const showPlans = React.useCallback(() => { hostSet.current?.(false); setPlansOpen(true); }, []);
  React.useEffect(() => { setSelectedPlans(new Set()); pendingExport.current = null; }, [projectId, scopeKey(scope), plans?.taskKey]);
  React.useLayoutEffect(() => {
    const element = listContainer.current; if (!element) return;
    const resize = new ResizeObserver(() => setListHeight(Math.max(40, element.clientHeight - 12)));
    resize.observe(element); return () => resize.disconnect();
  }, []);
  React.useEffect(() => {
    if (!switching) return;
    const block = (event: KeyboardEvent) => { event.preventDefault(); event.stopImmediatePropagation(); };
    window.addEventListener('keydown', block, true);
    return () => window.removeEventListener('keydown', block, true);
  }, [switching]);
  const setAddress = (id: string) => { const url = new URL(location.href); if (id === projectId) url.searchParams.delete('structureDraft'); else url.searchParams.set('structureDraft', id); history.replaceState(null, '', `${url.pathname}${url.search}`); };
  React.useEffect(() => {
    let alive = true;
    void api.structureWorkspace(projectId).then(async current => {
      if (current.activeProjectId !== projectId) current = await api.selectStructureDraft(projectId, current.activeProjectId);
      if (!alive) return;
      setWorkspace(current); setAddress(current.activeProjectId);
      const draft = current.drafts.find(item => item.projectId === current.activeProjectId); if (draft) setScope(draft.scope);
    }).catch(e => { if (alive) { setError(String(e.message ?? e)); setWorkspace({ ownerId: projectId, activeProjectId: projectId, drafts: [] }); } });
    void api.film(projectId).then(value => { if (alive) { setFolder(value.folder); setProjectTitle(value.project.name); } }).catch(e => { if (alive) setError(String(e.message ?? e)); });
    return () => { alive = false; generation.current += 1; request.current += 1; };
  }, [projectId]);
  const onScope = React.useCallback((next: StructureScope | null) => {
    if (scopeKey(currentScope.current) !== scopeKey(next)) { request.current += 1; generation.current += 1; currentScope.current = next; }
    setScope(previous => scopeKey(previous) === scopeKey(next) ? previous : next);
  }, []);
  const refreshPlans = async (selected: StructureScope) => {
    const token = ++request.current;
    try { const next = await api.structurePlans(projectId, selected); if (token === request.current && scopeKey(currentScope.current) === scopeKey(selected)) { setPlans(next); setError(''); } }
    catch (e) { if (token === request.current) setError(e instanceof Error ? e.message : String(e)); }
  };
  React.useEffect(() => {
    const token = ++request.current; generation.current += 1; setWorking(false); setPlans(null); setPreview(null); setGroup('');
    if (!scope) return;
    void api.structurePlans(projectId, scope).then(value => { if (request.current === token) setPlans(value); }, e => { if (request.current === token) setError(String(e.message ?? e)); });
  }, [projectId, scopeKey(scope)]);
  const compose = async (selected: StructureScope) => {
    showPlans(); setError('');
    // A card click carries the exact lecture even if React has not yet applied its selection.
    if (scopeKey(currentScope.current) !== scopeKey(selected)) { onScope(selected); return; }
    const token = ++generation.current; setWorking(true);
    try {
      let next = await api.structurePlans(projectId, selected);
      if (generation.current !== token) return;
      setPlans(next);
      if (next.status === 'idle' || next.status === 'running') {
        do {
          if (generation.current !== token) return;
          next = await api.generateStructurePlans(projectId, selected);
          if (generation.current !== token) return;
          setPlans(next);
          if (next.status === 'running') await new Promise(resolve => setTimeout(resolve, 50));
        } while (next.status === 'running');
      }
    } catch (e) { if (generation.current === token) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (generation.current === token) setWorking(false); }
  };
  const switchTo = async (id: string | null) => {
    if (switchLock.current) return; switchLock.current = true; setSwitching(true); setError('');
    try { await save.current(); const next = await api.selectStructureDraft(projectId, id); const selected = next.drafts.find(draft => draft.projectId === next.activeProjectId); if (selected) onScope(selected.scope); setPreview(null); setWorkspace(next); setAddress(next.activeProjectId); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { switchLock.current = false; setSwitching(false); }
  };
  const edit = async (plan: StructurePlan) => {
    if (!scope || !plans?.taskKey || switchLock.current) return; switchLock.current = true; setSwitching(true); setError('');
    try {
      await save.current();
      const draft = await api.editStructurePlan(projectId, scope, plans.taskKey, plan.id);
      const next = await api.selectStructureDraft(projectId, draft.project.id);
      setPreview(null); setWorkspace(next); setAddress(next.activeProjectId);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { switchLock.current = false; setSwitching(false); }
  };
  const groups = React.useMemo(() => groupStructurePlans(plans?.plans ?? []), [plans?.plans]);
  const mediaReview = React.useMemo(() => mediaReviewPresentation(plans?.mediaReview, plans?.mediaReviewOrigin), [plans?.mediaReview, plans?.mediaReviewOrigin]);
  const shown = group ? groups.find(item => item.key === group)?.plans ?? [] : plans?.plans ?? [];
  const selectedIds = selectedStructurePlanIds(plans?.plans ?? [], selectedPlans);
  const exportSelected = async (options: StructureBatchExportOptions) => {
    if (!scope || !plans?.taskKey || plans.status !== 'complete' || !selectedIds.length || switchLock.current) throw new Error('请等待保存完成后，重新勾选已发布的方案');
    switchLock.current = true; setSwitching(true); setBatchPreparing(true); setError('');
    const selection = { scope: { ...scope }, taskKey: plans.taskKey, planIds: [...selectedIds] };
    const signature = JSON.stringify({ ...selection, ...options });
    if (pendingExport.current?.signature !== signature) pendingExport.current = { signature, requestId: crypto.randomUUID() };
    const requestId = pendingExport.current.requestId;
    try {
      await save.current();
      await api.exportStructurePlans(projectId, selection.scope, selection.taskKey, selection.planIds, requestId, options);
      setSelectedPlans(new Set()); pendingExport.current = null;
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); throw e; }
    finally { setBatchRevision(value => value + 1); switchLock.current = false; setSwitching(false); setBatchPreparing(false); }
  };
  const activeDraft = workspace?.drafts.find(item => item.projectId === active);
  const draftLabel = activeDraft ? structureDraftLabel(activeDraft.planId, plans?.plans ?? []) : undefined;
  const bridge: StructureEditorBridge = { ownerId: projectId, scope, rightWidth: plansVisible ? 350 : 0, preview, previewFolder: folder, onScope, onCompose: selected => void compose(selected), onClosePreview: () => setPreview(null), onShowPlans: showPlans, registerSave, onReturnToProject: () => void switchTo(null), draftLabel,
    batchExport: selectedIds.length ? { projectId, title: projectTitle, ordinals: (plans?.plans ?? []).flatMap((plan, index) => selectedPlans.has(plan.id) ? [index + 1] : []), onExport: exportSelected } : undefined };
  return <div data-active-structure-draft={active}>
    {workspace && <div inert={switching} aria-busy={switching}><ProjectView key={active} projectId={active} onProject={onProject} onLeave={onLeave} structure={bridge} /></div>}
    {!workspace && <div className="p-6 text-[13px]">正在读取工程与个人草稿…</div>}
    <aside aria-label="公共结构方案" className={`fixed z-40 flex flex-col rounded-xl border border-[var(--border)] bg-[var(--dock-pane)] text-[var(--text)] shadow-lg transition-all duration-200 ${plansVisible ? 'opacity-100' : 'pointer-events-none translate-x-4 opacity-0'}`} style={{ top: 40, right: 8, bottom: 8, width: 334 }} aria-hidden={!plansVisible} inert={!plansVisible}>
      <div className="flex items-center gap-2 border-b border-[var(--border)] p-3"><ListVideo size={16} /><strong className="flex-1 text-[13px]">公共方案</strong><button aria-label="收起方案" className={button} onClick={() => setPlansOpen(false)}><X size={14} /></button></div>
      <div className="border-b border-[var(--border)] p-3 text-[12px]">
        <p>{draftLabel ? `下方编辑：${draftLabel}` : '下方编辑：已有成片'}</p>
        {workspace && workspace.drafts.length > 0 && <div className="mt-2 flex gap-1"><select aria-label="我的独立草稿" className="min-w-0 flex-1 rounded bg-[var(--surface)] p-1" value={active} disabled={switching} onChange={e => void switchTo(e.target.value)}><option value={projectId}>已有成片</option>{workspace.drafts.map(draft => <option key={draft.projectId} value={draft.projectId}>{structureDraftLabel(draft.planId, plans?.plans ?? [])}</option>)}</select>{activeDraft && <button className={button} disabled={switching} onClick={() => void switchTo(null)}>返回已有成片</button>}</div>}
        <p className="mt-2 text-[11px] text-[var(--text-muted)]">预览不改成片 · 编辑副本打开自己的独立草稿</p>
      </div>
      <div className="p-3 text-[12px]">
        {!scope ? <p>先在左侧选择一次商品讲解</p> : <>
          <p className="text-[var(--text-muted)]">本次讲解 {scope.startMs != null ? `${sourceTime(scope.startMs)}–${sourceTime(scope.endMs ?? 0)}` : ''}</p>
          <p className="mt-1">{plans?.allValidCombinationsEnumerated ? `已列出全部 ${plans.plans.length} 条有效方案` : plans?.complete ? `已列出 ${plans.plans.length} 条；待核对素材未纳入` : `已找到 ${plans?.plans.length ?? 0} 条${working || plans?.status === 'running' ? ' · 尚未算完' : ''}`}</p>
          <p className="mt-1 text-[11px] text-[var(--text-muted)]">30～50 秒供参考，按原速保留完整表达；请预览检查衔接</p>
          {plans && <details className="mt-1 text-[11px] text-[var(--text-muted)]" aria-label="方案复用的音画核查"><summary className="cursor-pointer transition-colors hover:text-[var(--accent)]">{mediaReview.summary}</summary><div className="mt-1 max-h-36 overflow-auto animate-in fade-in slide-in-from-top-1 duration-150">
            {mediaReview.originLabel && <p>{mediaReview.originLabel}</p>}{mediaReview.range && <p>{mediaReview.rangeLabel}：{mediaReview.range}</p>}<p>{mediaReview.note}</p>
            {mediaReview.segments.map((segment, index) => <div key={index} className="mt-2"><p>{segment.range}</p><p>{segment.visual}</p><p>{segment.audio}</p>{segment.issues.map((issue, i) => <p key={i} className="text-[var(--warn)]">{issue}</p>)}</div>)}
            {mediaReview.issues.map((issue, index) => <p key={index} className="mt-1 text-[var(--warn)]">{issue}</p>)}
          </div></details>}
          {plans && <ProductVisualReviewDetails review={plans.visualReview} origin={plans.visualReviewOrigin ?? 'shared'} stale={plans.visualReviewStale} label="方案复用的 AI 看图核查" />}
          {['idle', 'running'].includes(plans?.status ?? '') && <button className={`${button} mt-2`} disabled={working} onClick={() => void compose(scope)}>{working ? '正在枚举…' : plans?.status === 'running' ? '继续计算' : '拼结构'}</button>}
          {working && <button className={`${button} ml-2`} onClick={() => { generation.current += 1; setWorking(false); }}>暂停计算</button>}
          {plans?.status === 'busy' && <p className="mt-2">公共任务正在处理或等待恢复，未重复生成</p>}
          {plans?.status === 'running' && <p className="mt-2 text-[var(--text-muted)]">正在计算的方案尚未发布，可先预览</p>}
          {plans?.status === 'publish-pending' && <p className="mt-2 text-[var(--warn)]">本机结果已保留，公共保存尚未完成；补存只保存已有结果</p>}
          {plans?.status === 'publish-pending' && <button className={`${button} mt-2`} disabled={working} onClick={async () => { const selected = scope, token = ++generation.current; setWorking(true); try { await api.publishStructurePlans(projectId, selected.sourceId, plans.taskKey!); if (token === generation.current) await refreshPlans(selected); } catch (e) { if (token === generation.current) setError(String(e)); } finally { if (token === generation.current) setWorking(false); } }}>补存已有公共结果</button>}
          <button className={`${button} ml-2 mt-2`} disabled={working} onClick={() => void refreshPlans(scope)}>刷新读取</button>
        </>}
        {plans?.issues?.length ? <details className="mt-2" open={!plans.plans.length}><summary className="cursor-pointer">需核对 {plans.issues.length} 项</summary><div className="max-h-44 overflow-auto">{plans.issues.map((issue, index) => <p key={index} className="mt-1 text-[var(--warn)]">{issue.startMs != null ? `${sourceTime(issue.startMs)}–${sourceTime(issue.endMs ?? issue.startMs)} ` : ''}{issue.message}{issue.text && <span className="block text-[var(--text-muted)]">原话：{issue.text}</span>}</p>)}</div><p className="mt-2 text-[var(--text-muted)]">沿用已有话术记录；缺失信息未猜测，也未重新请求模型</p></details> : null}
        {error && <p role="alert" className="mt-2 text-[var(--warn)]">{error}</p>}
        {groups.length > 1 && <select aria-label="按核心卖点分组" className="mt-2 w-full rounded bg-[var(--surface)] p-1" value={group} onChange={e => setGroup(e.target.value)}><option value="">全部方案 · {plans?.plans.length} 条</option>{groups.map(item => <option key={item.key} value={item.key}>{structureGroupLabel(item.plans[0]!)} · {item.plans.length} 条</option>)}</select>}
      </div>
      {!!plans?.plans.length && <div className="flex shrink-0 items-center gap-2 px-3 pb-2 text-[11px]">
        <button className={button} disabled={switching || plans.status !== 'complete'} onClick={() => setSelectedPlans(new Set(plans.plans.map(plan => plan.id)))}>全选全部方案</button>
        {group && <button className={button} disabled={switching || plans.status !== 'complete'} onClick={() => setSelectedPlans(previous => new Set([...previous, ...shown.map(plan => plan.id)]))}>全选当前分组</button>}
        <button className={button} disabled={switching || !selectedIds.length} onClick={() => setSelectedPlans(new Set())}>清空选择</button>
      </div>}
      <div ref={listContainer} className="min-h-0 flex-1 px-3 pb-3">
        <VirtualList label="结构方案列表" items={shown} itemKey={plan => plan.id} estimateHeight={() => 264} gap={10} maxHeight={listHeight} renderItem={plan => {
          const number = (plans?.plans.findIndex(item => item.id === plan.id) ?? 0) + 1;
          const card = structurePlanCard(plan), selected = preview?.id === plan.id;
          const chip = 'rounded-sm border border-[var(--border)] px-1 py-0.5 text-[9px] leading-none text-[var(--text-muted)]';
          return <article data-structure-plan={plan.id} className={`flex min-h-[228px] flex-col rounded-lg border p-3 transition-all duration-200 animate-in fade-in slide-in-from-bottom-1 ${selected ? 'border-[var(--accent)]' : 'border-[var(--border)] hover:border-[var(--text-dim)]'}`} style={{ background: selected ? 'color-mix(in srgb, var(--accent) 12%, var(--dock-pane))' : 'var(--surface)' }}>
            <label className="mb-2 flex cursor-pointer items-center gap-2 text-[11px]">
              <input type="checkbox" aria-label={`选择方案 ${number} 导出`} checked={selectedPlans.has(plan.id)} disabled={switching || plans?.status !== 'complete'} onChange={() => setSelectedPlans(previous => toggleStructurePlan(previous, plan.id))} className="h-3.5 w-3.5 accent-[var(--accent)] transition" />
              选择导出 · 方案 {String(number).padStart(3, '0')}
            </label>
            <button aria-label={`查看方案 ${planLetter(number - 1)} 预览`} aria-pressed={selected} className="w-full rounded text-left transition duration-150 active:scale-[0.99]" onClick={() => setPreview(plan)}>
              <div className="flex items-center gap-2">
                <span className={`flex h-5 min-w-5 items-center justify-center rounded border px-1 text-[10px] ${selected ? 'border-[var(--accent)] bg-[var(--bg-hover)] text-[var(--accent)]' : 'border-[var(--border)] text-[var(--text-muted)]'}`}>{planLetter(number - 1)}</span>
                <strong className="min-w-0 flex-1 line-clamp-2 text-[12px] leading-4" title={card.title}>{card.title}</strong>
                <span className="shrink-0 text-[11px] font-semibold tabular-nums">{card.durationLabel}</span>
              </div>
              <p className="mt-1.5 line-clamp-2 text-[10px] leading-4 text-[var(--text-muted)]" title={card.fullCoreQuotes}>{card.subtitle}</p>
              <p className="mt-1 truncate text-[10px] leading-4 text-[var(--text-muted)]" title={card.fullHook}>{card.hook}</p>
              <div aria-label="方案结构" className="mt-2.5 flex gap-1 overflow-x-auto pb-0.5">
                {card.blocks.map((block, index) => <span key={index} title={`${block.fullLabel} · ${(block.durationMs / 1000).toFixed(1)}秒`} className="flex h-6 min-w-[40px] items-center justify-center rounded-sm px-1 text-[9px] text-[var(--text-muted)]" style={{ flexGrow: block.durationMs, flexBasis: 0, background: `color-mix(in srgb, ${block.color} 23%, transparent)` }}>{block.label}</span>)}
              </div>
              <p className="mt-2 line-clamp-2 min-h-8 text-[10px] leading-4 text-[var(--text-muted)]" title={card.summary}>{card.summary}</p>
            </button>
            <div className="mt-2 flex flex-wrap items-center gap-1"><span className={chip}>{card.coreCount}个卖点</span><span className={chip}>原速</span><span className={chip} style={plan.durationMs < 30000 || plan.durationMs > 50000 ? { color: 'var(--warn)' } : undefined}>{card.durationHint}</span></div>
            <details className="group mt-1.5 text-[10px] text-[var(--text-muted)]">
              <summary className="cursor-pointer rounded py-0.5 transition hover:text-[var(--text)]">完整原话与来源 · {plan.clips.length}段</summary>
              <div className="mt-1 max-h-60 overflow-auto border-t border-[var(--border)] pb-1 animate-in fade-in slide-in-from-top-1 duration-150">{plan.clips.map((clip, index) => <p key={index} className="mt-2 text-[11px] leading-relaxed"><span className="mb-0.5 block text-[var(--text-dim)]">{clip.roles.map(structureRole).join('/')} · {sourceTime(clip.startMs)}–{sourceTime(clip.endMs)}{clip.assetPath ? ` · ${clip.assetPath}` : ''}</span>{clip.text}</p>)}</div>
            </details>
            <div className="mt-auto grid grid-cols-2 gap-2 pt-2">
              <button aria-label={`预览方案 ${number}`} aria-pressed={selected} className={`${button} flex h-7 items-center justify-center gap-1 text-[10px]`} onClick={() => setPreview(plan)}>{selected ? <><span className="h-1 w-1 rounded-full bg-[var(--accent)]" />正在预览</> : <><Play size={11} />预览方案</>}</button>
              <button className={`${button} flex h-7 items-center justify-center gap-1 border-transparent bg-[var(--accent)] text-[10px] font-medium text-[var(--accent-text,#fff)] hover:brightness-110`} disabled={switching || plans?.status !== 'complete'} onClick={() => void edit(plan)}>编辑副本<ArrowUpRight size={11} /></button>
            </div>
          </article>;
        }} />
      </div>
      <div className="shrink-0 border-t border-[var(--border)] p-3 text-[11px]">
        <p aria-live="polite" className="mb-2">已选 {selectedIds.length} 条</p>
        <p className="text-[var(--text-muted)]">{batchPreparing ? '正在保存并固定版本…' : '勾选或全选后，点击右上角「导出」命名并导出'}</p>
        <p className="mt-1 text-[var(--text-muted)]">优先使用个人草稿 · 每条单独一份</p>
      </div>
      <StructureExportBatches projectId={projectId} revision={batchRevision} />
    </aside>
    {!plansVisible && !host?.open && <button className={`${button} fixed right-3 top-10 z-50 bg-[var(--surface)]`} onClick={showPlans}><ListVideo size={14} className="mr-1 inline" />公共方案</button>}
  </div>;
}
