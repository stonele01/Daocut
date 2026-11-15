import * as React from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpRight, ChevronDown, ListVideo, Play, X } from 'lucide-react';
import { api } from '@/api';
import { requestFeedback } from '@/lib/feedback-request';
import { useHostPanel } from '@/lib/host';
import { groupStructurePlansByOpening, isSavedStructurePlanUsable, needsStructureGeneration, structureRole, type StructurePlan, type StructurePlansState, type StructureScope, type StructureWorkspaceState } from '@/lib/structure-workspace';
import { sourceTime } from '@/lib/product-analysis';
import { structureDraftLabel, structurePlanCard } from '@/lib/structure-plan-card';
import { ProjectView } from './ProjectView';
import { VirtualList } from './VirtualList';
import { StructureExportBatches } from './StructureExportBatches';
import { selectedStructurePlanIds, toggleStructurePlan, type StructureBatchExportSelection, type StructureBatchExportOptions } from '@/lib/structure-export-selection';

export interface StructureEditorBridge {
  ownerId: string; scope: StructureScope | null; rightWidth: number; preview: StructurePlan | null; previewFolder: string;
  previewRequest: { clipIndex: number; requestId: number };
  onScope: (scope: StructureScope | null) => void; onCompose: (scope: StructureScope) => void;
  onClosePreview: () => void; onShowPlans: () => void; registerSave: (save: () => Promise<void>) => () => void;
  onReturnToProject: () => void;
  onAnalysisUpdated?: () => void;
  draftLabel?: string;
  batchExport?: StructureBatchExportSelection;
}
const button = 'rounded border border-[var(--border)] px-2 py-1 text-[12px] transition duration-150 hover:bg-[var(--bg-hover)] active:scale-95 disabled:opacity-40';
const scopeKey = (scope: StructureScope | null) => scope ? `${scope.sourceId}:${scope.productId}:${scope.intervalId}:${scope.startMs ?? ''}:${scope.endMs ?? ''}` : '';

function StructureComposeConfirmation({ plan, onConfirm, onClose }: { plan: NonNullable<StructurePlansState['confirmation']>; onConfirm: () => void; onClose: () => void }) {
  const dialog = React.useRef<HTMLDivElement>(null), cancel = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => { const previous = document.activeElement as HTMLElement | null; cancel.current?.focus(); return () => previous?.focus?.(); }, []);
  return createPortal(<div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 p-4 animate-in fade-in duration-150" onClick={onClose}>
    <div ref={dialog} role="dialog" aria-modal="true" aria-label="确认 AI 拼结构" className="w-full max-w-[420px] rounded-xl border border-[var(--border)] bg-[var(--dock-pane)] p-4 text-[12px] text-[var(--text)] shadow-xl animate-in fade-in zoom-in-95 duration-150" onClick={event => event.stopPropagation()} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (event.key === 'Tab') { const buttons = dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'); if (!buttons?.length) return; const first = buttons[0]!, last = buttons[buttons.length - 1]!; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } }
    }}>
      <strong className="text-[14px]">拼结构</strong>
      <p className="mt-3">根据当前商品的话术生成视频方案，完成后可预览和导出。</p>
      {plan.openingCount != null && <p className="mt-2">本次处理 {plan.openingCount} 个开头。</p>}
      <p className="mt-2 text-[var(--text-muted)]">本次最多调用模型 {plan.requestCount ?? 1} 次，可能产生费用。完成后自动保存。</p>
      {!plan.enabled && <p role="alert" className="mt-3 text-[var(--warn)]">{plan.message}</p>}
      <div className="mt-4 flex gap-2"><button className={`${button} min-h-9 flex-1 bg-[var(--accent)] text-[var(--accent-text,#fff)]`} disabled={!plan.enabled || !plan.id} onClick={onConfirm}>确认 AI 拼结构</button><button ref={cancel} className={`${button} min-h-9 px-4`} onClick={onClose}>取消</button></div>
    </div>
  </div>, document.body);
}

export function StructureWorkspace({ projectId, onProject, onLeave }: { projectId: string; onProject: (id: string) => void; onLeave: () => void }) {
  const [workspace, setWorkspace] = React.useState<StructureWorkspaceState | null>(null);
  const [scope, setScope] = React.useState<StructureScope | null>(null);
  const currentScope = React.useRef(scope); currentScope.current = scope;
  const [plans, setPlans] = React.useState<StructurePlansState | null>(null);
  const [rulesVersion, setRulesVersion] = React.useState<string | undefined>();
  const currentRules = React.useRef<string | undefined>(undefined);
  const [preview, setPreview] = React.useState<StructurePlan | null>(null);
  const [previewRequest, setPreviewRequest] = React.useState({ clipIndex: 0, requestId: 0 });
  const openPreview = (plan: StructurePlan, clipIndex = 0) => {
    setPreviewRequest(previous => ({ clipIndex, requestId: previous.requestId + 1 }));
    setPreview(plan);
  };
  const closePreview = React.useCallback(() => setPreview(null), []);
  const acceptPlans = (next: StructurePlansState, requestedVersion?: string) => {
    const version = next.version ?? requestedVersion;
    if (currentRules.current !== version) { setPreview(null); setOpeningTypeFilter(''); }
    currentRules.current = version; setRulesVersion(version); setPlans(next);
  };
  const [folder, setFolder] = React.useState('');
  const [projectTitle, setProjectTitle] = React.useState('结构视频');
  const [error, setError] = React.useState(''), [working, setWorking] = React.useState(false), [switching, setSwitching] = React.useState(false);
  const [plansOpen, setPlansOpen] = React.useState(true);
  const [openingTypeFilter, setOpeningTypeFilter] = React.useState('');
  const [expandedOpenings, setExpandedOpenings] = React.useState<Set<string>>(() => new Set());
  const [selectedPlans, setSelectedPlans] = React.useState<Set<string>>(() => new Set());
  const [batchRevision, setBatchRevision] = React.useState(0);
  const [batchPreparing, setBatchPreparing] = React.useState(false);
  const [confirmation, setConfirmation] = React.useState<{ scope: StructureScope; plan: NonNullable<StructurePlansState['confirmation']> } | null>(null);
  const composeAfterSelection = React.useRef('');
  const submitLock = React.useRef(false);
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
  const refreshPlans = async (selected: StructureScope, version = currentRules.current) => {
    const token = ++request.current;
    try { const next = await api.structurePlans(projectId, selected, version); if (token === request.current && scopeKey(currentScope.current) === scopeKey(selected)) { acceptPlans(next, version); setError(''); } }
    catch (e) { if (token === request.current) setError(e instanceof Error ? e.message : String(e)); }
  };
  React.useEffect(() => {
    const token = ++request.current; generation.current += 1; setWorking(false); setPlans(null); setPreview(null); setOpeningTypeFilter(''); setConfirmation(null); currentRules.current = undefined; setRulesVersion(undefined);
    if (!scope) return;
    const composeOnLoad = composeAfterSelection.current === scopeKey(scope); composeAfterSelection.current = '';
    void api.structurePlans(projectId, scope).then(value => { if (request.current !== token) return; acceptPlans(value); if (composeOnLoad && value.confirmation && needsStructureGeneration(value)) setConfirmation({ scope, plan: value.confirmation }); }, e => { if (request.current === token) setError(String(e.message ?? e)); });
  }, [projectId, scopeKey(scope)]);
  // Once submitted, polling and reopening only read progress; they never resubmit AI work.
  React.useEffect(() => {
    if (!scope || plans?.status !== 'running') return;
    let alive = true, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const next = await api.structurePlans(projectId, scope, rulesVersion); if (!alive || currentRules.current !== rulesVersion || scopeKey(currentScope.current) !== scopeKey(scope)) return; acceptPlans(next, rulesVersion); if (next.status === 'running') timer = setTimeout(poll, 1000); }
      catch (e) { if (alive) setError(e instanceof Error ? e.message : String(e)); }
    };
    timer = setTimeout(poll, 1000); return () => { alive = false; clearTimeout(timer); };
  }, [projectId, scopeKey(scope), plans?.status, rulesVersion]);
  const compose = async (selected: StructureScope) => {
    showPlans(); setError('');
    // A card click carries the exact lecture even if React has not yet applied its selection.
    if (scopeKey(currentScope.current) !== scopeKey(selected)) { composeAfterSelection.current = scopeKey(selected); onScope(selected); return; }
    const token = ++generation.current; request.current += 1; setWorking(true);
    try {
      const next = await api.structurePlans(projectId, selected);
      if (generation.current !== token) return;
      const needsConfirmation = needsStructureGeneration(next) && next.confirmation;
      // Read current analysis/results without submitting another generation.
      acceptPlans(next);
      if (needsConfirmation) setConfirmation({ scope: selected, plan: next.confirmation! });
    } catch (e) { if (generation.current === token) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (generation.current === token) setWorking(false); }
  };
  const confirmComposition = async () => {
    if (!confirmation?.plan.id || submitLock.current) return;
    submitLock.current = true;
    const selected = confirmation.scope, plan = confirmation.plan, version = plan.rulesVersion ?? currentRules.current, token = ++generation.current;
    setConfirmation(null); setWorking(true); setError('');
    try { const next = await api.generateStructurePlans(projectId, selected, plan.id!, !!plan.continuation, version); if (generation.current === token) acceptPlans(next, version); }
    catch (e) { if (generation.current === token) { await refreshPlans(selected, version); if (generation.current === token) setError(e instanceof Error ? e.message : String(e)); } }
    finally { submitLock.current = false; if (generation.current === token) setWorking(false); }
  };
  const switchTo = async (id: string | null) => {
    if (switchLock.current) return; switchLock.current = true; setSwitching(true); setError('');
    try { await save.current(); const next = await api.selectStructureDraft(projectId, id); const selected = next.drafts.find(draft => draft.projectId === next.activeProjectId); if (selected) onScope(selected.scope); setPreview(null); setWorkspace(next); setAddress(next.activeProjectId); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { switchLock.current = false; setSwitching(false); }
  };
  const edit = async (plan: StructurePlan) => {
    if (!scope || !plans?.taskKey || !isSavedStructurePlanUsable(plans, plan.id) || switchLock.current) return; switchLock.current = true; setSwitching(true); setError('');
    try {
      await save.current();
      const draft = await api.editStructurePlan(projectId, scope, plans.taskKey, plan.id);
      const next = await api.selectStructureDraft(projectId, draft.project.id);
      setPreview(null); setWorkspace(next); setAddress(next.activeProjectId);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { switchLock.current = false; setSwitching(false); }
  };
  const groups = React.useMemo(() => groupStructurePlansByOpening(plans?.plans ?? []), [plans?.plans]);
  React.useEffect(() => { setExpandedOpenings(new Set(groups[0] ? [groups[0].key] : [])); }, [plans?.taskKey, groups[0]?.key]);
  const openingTypes = [...new Set(groups.map(group => structurePlanCard(group.plans[0]!).openingType))];
  const shownGroups = openingTypeFilter ? groups.filter(group => structurePlanCard(group.plans[0]!).openingType === openingTypeFilter) : groups;
  const localPlans = plans?.context?.visibility === 'local';
  const planTitle = localPlans ? '本机方案' : '公共方案';
  const shown = shownGroups.flatMap(group => group.plans);
  type OpeningGroup = typeof groups[number];
  type PlanRow = { kind: 'opening'; key: string; group: OpeningGroup } | { kind: 'plan'; key: string; plan: StructurePlan };
  const rows: PlanRow[] = shownGroups.flatMap(group => [
    { kind: 'opening' as const, key: `opening:${group.key}`, group },
    ...(expandedOpenings.has(group.key) ? group.plans.map(plan => ({ kind: 'plan' as const, key: `plan:${plan.id}`, plan })) : []),
  ]);
  const usablePlans = (plans?.plans ?? []).filter(plan => isSavedStructurePlanUsable(plans, plan.id));
  const usableShown = shown.filter(plan => isSavedStructurePlanUsable(plans, plan.id));
  const selectedIds = selectedStructurePlanIds(usablePlans, selectedPlans);
  const exportSelected = async (options: StructureBatchExportOptions) => {
    if (!scope || !plans?.taskKey || !selectedIds.length || selectedIds.some(id => !isSavedStructurePlanUsable(plans, id)) || switchLock.current) throw new Error('请等待保存完成后，重新勾选已保存的方案');
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
  const bridge: StructureEditorBridge = { ownerId: projectId, scope, rightWidth: plansVisible ? 350 : 0, preview, previewRequest, previewFolder: folder, onScope, onCompose: selected => void compose(selected), onClosePreview: closePreview, onShowPlans: showPlans, registerSave, onReturnToProject: () => void switchTo(null), onAnalysisUpdated: () => { const selected = currentScope.current; if (selected) void refreshPlans(selected); }, draftLabel,
    batchExport: selectedIds.length ? { projectId, title: projectTitle, ordinals: (plans?.plans ?? []).flatMap((plan, index) => selectedIds.includes(plan.id) ? [index + 1] : []), onExport: exportSelected } : undefined };
  return <div data-active-structure-draft={active} inert={!!confirmation}>
    {workspace && <div inert={switching} aria-busy={switching}><ProjectView key={active} projectId={active} onProject={onProject} onLeave={onLeave} structure={bridge} /></div>}
    {!workspace && <div className="p-6 text-[13px]">正在读取工程与个人草稿…</div>}
    <aside aria-label={localPlans ? '本机结构方案' : '公共结构方案'} className={`fixed z-40 flex flex-col rounded-xl border border-[var(--border)] bg-[var(--dock-pane)] text-[var(--text)] shadow-lg transition-all duration-200 ${plansVisible ? 'opacity-100' : 'pointer-events-none translate-x-4 opacity-0'}`} style={{ top: 40, right: 8, bottom: 8, width: 334 }} aria-hidden={!plansVisible} inert={!plansVisible}>
      <div className="flex items-center gap-2 border-b border-[var(--border)] p-3"><ListVideo size={16} /><strong className="flex-1 text-[13px]">{planTitle}</strong><button aria-label="收起方案" className={button} onClick={() => setPlansOpen(false)}><X size={14} /></button></div>
      <div className="border-b border-[var(--border)] p-3 text-[12px]">
        {workspace && workspace.drafts.length > 0 ? <div className="flex items-center gap-1"><span className="shrink-0 text-[11px] text-[var(--text-muted)]">当前编辑</span><select aria-label="我的独立草稿" className="min-w-0 flex-1 rounded bg-[var(--surface)] p-1" value={active} disabled={switching} onChange={e => void switchTo(e.target.value)}><option value={projectId}>已有成片</option>{workspace.drafts.map(draft => <option key={draft.projectId} value={draft.projectId}>{structureDraftLabel(draft.planId, plans?.plans ?? [])}</option>)}</select>{activeDraft && <button className={button} disabled={switching} onClick={() => void switchTo(null)}>返回已有成片</button>}</div> : <p className="text-[11px] text-[var(--text-muted)]">当前编辑：已有成片</p>}
      </div>
      <div className="p-3 text-[12px]">
        {!scope ? <p>先在左侧选择一次商品讲解</p> : <>
          {plans?.status === 'unavailable' && <p role="alert" className="mt-2 text-[var(--warn)]">暂时不能拼结构：{plans.issues?.[0]?.message ?? '当前话术信息不足，请核对已有分析'}</p>}
          <p className="font-medium">{groups.length} 个开头 · {plans?.plans.length ?? 0} 条方案</p>
          {plans?.coverage && <div role="status" aria-label="开头覆盖进度" className="mt-1 text-[11px] text-[var(--text-muted)] animate-in fade-in duration-150">{['ai-structure-plans-v5', 'ai-structure-plans-v6', 'ai-structure-plans-v7', 'ai-structure-plans-v8'].includes(plans.version ?? '') ? <><p>本轮已处理 {plans.coverage.total - plans.coverage.remainingIds.length}/{plans.coverage.total} 个开头</p>{!!plans.coverage.remainingIds.length && <p className="mt-1">待补充 {plans.coverage.remainingIds.length} 个开头</p>}{plans.coverage.openingCovered != null && plans.coverage.openingCovered < plans.coverage.total && <p className="mt-1">其中 {plans.coverage.total - plans.coverage.openingCovered} 个开头暂未生成可用方案</p>}</> : <><p>开头已覆盖 {plans.coverage.covered}/{plans.coverage.total}</p>{plans.coverage.remainingIds.length > 0 ? <p className="mt-1">还有 {plans.coverage.remainingIds.length} 个开头未生成有效方案</p> : plans.coverage.total > 0 && <p className="mt-1">全部可用开头已有有效方案</p>}</>}</div>}
          {needsStructureGeneration(plans) && <button className={`${button} mt-2 w-full border-transparent bg-[var(--accent)] text-[var(--accent-text,#fff)] hover:brightness-110`} disabled={working || switching} onClick={() => void compose(scope)}>{working ? '正在读取…' : plans?.status === 'idle' ? '拼结构' : '继续拼结构'}</button>}
          {plans?.status === 'busy' && <p className="mt-2">公共任务正在处理或等待恢复，未重复生成</p>}
          {plans?.status === 'running' && <p className="mt-2 text-[var(--text-muted)]">AI 正在拼结构，返回后自动保存；切换或重开只读取进度，不重复发送</p>}
          {plans?.status === 'failed' && <p role="alert" className="mt-2 text-[var(--warn)]">本次生成失败，已有方案已保留</p>}
          {plans?.status === 'failed' && plans.recoverable && <button className={`${button} mt-2`} disabled={working} onClick={async () => { const selected = scope, version = currentRules.current, token = ++generation.current; setWorking(true); try { const next = await api.recoverStructurePlans(projectId, selected, version); if (token === generation.current) acceptPlans(next, version); } catch (e) { if (token === generation.current) setError(String(e)); } finally { if (token === generation.current) setWorking(false); } }}>恢复已保存返回</button>}
          {plans?.status === 'publish-pending' && <p className="mt-2 text-[var(--warn)]">本机结果已保留，公共保存尚未完成；补存只保存已有结果</p>}
          {plans?.status === 'publish-pending' && <button className={`${button} mt-2`} disabled={working} onClick={async () => { const selected = scope, token = ++generation.current; setWorking(true); try { await api.publishStructurePlans(projectId, selected.sourceId, plans.taskKey!); if (token === generation.current) await refreshPlans(selected); } catch (e) { if (token === generation.current) setError(String(e)); } finally { if (token === generation.current) setWorking(false); } }}>补存已有公共结果</button>}
        </>}
        {error && <p role="alert" className="mt-2 text-[var(--warn)]">{error}</p>}
        {(error || ['failed', 'unavailable', 'publish-pending'].includes(plans?.status ?? '')) && <button className={`${button} mt-2`} onClick={() => requestFeedback([error || '结构方案未完成', ...(plans?.issues ?? []).map(issue => issue.message)].join('\n'), 'structure')}>反馈问题</button>}
        {scope && <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-[var(--text-muted)]">
          <span>{plans?.plans.length && plans.plans.every(plan => plan.speed === 1) ? '原速 · 保留完整表达' : '1.3 倍速 · 30～40 秒'}</span>
          <button className={button} disabled={working} onClick={() => void refreshPlans(scope)}>刷新读取</button>
        </div>}
        {openingTypes.length > 1 && <select aria-label="按开头类型筛选" className="mt-2 w-full rounded bg-[var(--surface)] p-1 transition" value={openingTypeFilter} onChange={event => setOpeningTypeFilter(event.target.value)}><option value="">全部开头 · {groups.length} 组</option>{openingTypes.map(type => <option key={type} value={type}>{type} · {groups.filter(group => structurePlanCard(group.plans[0]!).openingType === type).length} 组</option>)}</select>}
      </div>
      {!!plans?.plans.length && <div className="flex shrink-0 items-center gap-2 px-3 pb-2 text-[11px]">
        <button className={button} disabled={switching || !usablePlans.length} onClick={() => setSelectedPlans(new Set(usablePlans.map(plan => plan.id)))}>全选全部方案</button>
        {openingTypeFilter && <button className={button} disabled={switching || !usableShown.length} onClick={() => setSelectedPlans(previous => new Set([...previous, ...usableShown.map(plan => plan.id)]))}>全选筛选结果</button>}
        <button className={button} disabled={switching || !selectedIds.length} onClick={() => setSelectedPlans(new Set())}>清空选择</button>
      </div>}
      <div ref={listContainer} className="min-h-0 flex-1 px-3 pb-3">
        <VirtualList label="结构方案列表" items={rows} itemKey={row => row.key} estimateHeight={row => row.kind === 'opening' ? 62 : 190} gap={8} maxHeight={listHeight} renderItem={row => {
          if (row.kind === 'opening') {
            const group = row.group, card = structurePlanCard(group.plans[0]!), expanded = expandedOpenings.has(group.key);
            const distinctCount = plans?.coverage?.perOpening?.find(item => item.openingId === group.openingId)?.distinctCount;
            return <button type="button" data-opening-group={group.openingId ?? group.key} aria-label={`${expanded ? '收起' : '展开'}开头 ${card.title}`} aria-expanded={expanded} title={card.fullHook} className="flex w-full items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-hover)] p-2.5 text-left transition duration-150 hover:border-[var(--accent)] active:scale-[0.99] animate-in fade-in slide-in-from-top-1" onClick={() => setExpandedOpenings(previous => { const next = new Set(previous); if (next.has(group.key)) next.delete(group.key); else next.add(group.key); return next; })}><ChevronDown size={14} className={`shrink-0 transition-transform duration-150 ${expanded ? '' : '-rotate-90'}`} /><strong className="min-w-0 flex-1 line-clamp-2 text-[12px] leading-4">{card.title}</strong><span className="shrink-0 text-[11px] tabular-nums text-[var(--text-muted)]">{distinctCount != null ? `${distinctCount} 种结构` : `${group.plans.length} 条`}</span></button>;
          }
          const plan = row.plan;
          const number = (plans?.plans.findIndex(item => item.id === plan.id) ?? 0) + 1;
          const card = structurePlanCard(plan), selected = preview?.id === plan.id;
          return <article data-structure-plan={plan.id} className={`ml-3 flex min-h-[176px] flex-col rounded-lg border p-2.5 transition-all duration-200 animate-in fade-in slide-in-from-top-1 ${selected ? 'border-[var(--accent)]' : 'border-[var(--border)] hover:border-[var(--text-dim)]'}`} style={{ background: selected ? 'color-mix(in srgb, var(--accent) 12%, var(--dock-pane))' : 'var(--surface)' }}>
            <label className="mb-2 flex cursor-pointer items-center gap-2 text-[11px]">
              <input type="checkbox" aria-label={`选择方案 ${number} 导出`} checked={selectedIds.includes(plan.id)} disabled={switching || !isSavedStructurePlanUsable(plans, plan.id)} onChange={() => setSelectedPlans(previous => toggleStructurePlan(previous, plan.id))} className="h-3.5 w-3.5 accent-[var(--accent)] transition" />
              <span className="flex-1">方案 {String(number).padStart(3, '0')}</span><span className="font-semibold tabular-nums">{card.durationLabel}</span>
            </label>
            <p className="line-clamp-2 text-[11px] leading-4 text-[var(--text-muted)]" title={card.fullCoreQuotes}>{card.subtitle}</p>
            <div aria-label="方案结构" className="mt-2.5 flex gap-1 overflow-x-auto pb-0.5">
              {card.blocks.map((block, index) => <button type="button" key={index} aria-label={`预览方案 ${number} 第 ${index + 1} 段 ${block.fullLabel}`} title={`点击预览 · ${block.fullLabel} · ${(block.durationMs / 1000).toFixed(1)}秒`} onClick={() => openPreview(plan, index)} className="flex h-6 min-w-[40px] items-center justify-center rounded-sm px-1 text-[9px] text-[var(--text-muted)] transition duration-150 hover:brightness-125 active:scale-95 focus-visible:outline-2 focus-visible:outline-[var(--accent)]" style={{ flexGrow: block.durationMs, flexBasis: 0, background: `color-mix(in srgb, ${block.color} 23%, transparent)` }}>{block.label}</button>)}
            </div>
            {!card.durationInRange && <p className="mt-1 text-[10px] text-[var(--warn)]">{card.durationHint}</p>}
            <details className="group mt-1.5 text-[10px] text-[var(--text-muted)]">
              <summary className="cursor-pointer rounded py-0.5 transition hover:text-[var(--text)]">完整原话与来源 · {plan.clips.length}段</summary>
              <div className="mt-1 max-h-60 overflow-auto border-t border-[var(--border)] pb-1 animate-in fade-in slide-in-from-top-1 duration-150"><p className="mt-1">{card.coreCount} 个卖点 · {card.speedLabel} · {card.summary}</p>{plan.clips.map((clip, index) => <button type="button" key={index} aria-label={`预览原话 ${number} 第 ${index + 1} 段`} title="点击跳到这段原片" onClick={() => openPreview(plan, index)} className="mt-2 block w-full rounded text-left text-[11px] leading-relaxed transition duration-150 hover:bg-[var(--bg-hover)] active:scale-[0.99] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"><span className="mb-0.5 block text-[var(--text-dim)]">{clip.roles.map(structureRole).join('/')} · {sourceTime(clip.startMs)}–{sourceTime(clip.endMs)}{clip.assetPath ? ` · ${clip.assetPath}` : ''}</span>{clip.text}</button>)}</div>
            </details>
            <div className="mt-auto grid grid-cols-2 gap-2 pt-2">
              <button aria-label={`预览方案 ${number}`} aria-pressed={selected} className={`${button} flex h-7 items-center justify-center gap-1 text-[10px]`} onClick={() => openPreview(plan)}>{selected ? <><span className="h-1 w-1 rounded-full bg-[var(--accent)]" />正在预览</> : <><Play size={11} />预览方案</>}</button>
              <button className={`${button} flex h-7 items-center justify-center gap-1 border-transparent bg-[var(--accent)] text-[10px] font-medium text-[var(--accent-text,#fff)] hover:brightness-110`} disabled={switching || !isSavedStructurePlanUsable(plans, plan.id)} onClick={() => void edit(plan)}>编辑副本<ArrowUpRight size={11} /></button>
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
    {!plansVisible && !host?.open && <button className={`${button} fixed right-3 top-10 z-50 bg-[var(--surface)]`} onClick={showPlans}><ListVideo size={14} className="mr-1 inline" />{planTitle}</button>}
    {confirmation && <StructureComposeConfirmation {...confirmation} onConfirm={() => void confirmComposition()} onClose={() => setConfirmation(null)} />}
  </div>;
}
