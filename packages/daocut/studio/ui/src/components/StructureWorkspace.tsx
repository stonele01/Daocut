import * as React from 'react';
import { createPortal } from 'react-dom';
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
  previewRequest: { clipIndex: number; requestId: number };
  onScope: (scope: StructureScope | null) => void; onCompose: (scope: StructureScope) => void;
  onClosePreview: () => void; onShowPlans: () => void; registerSave: (save: () => Promise<void>) => () => void;
  onReturnToProject: () => void;
  draftLabel?: string;
  batchExport?: StructureBatchExportSelection;
}
const button = 'rounded border border-[var(--border)] px-2 py-1 text-[12px] transition duration-150 hover:bg-[var(--bg-hover)] active:scale-95 disabled:opacity-40';
const scopeKey = (scope: StructureScope | null) => scope ? `${scope.sourceId}:${scope.productId}:${scope.intervalId}:${scope.startMs ?? ''}:${scope.endMs ?? ''}` : '';

function StructureComposeConfirmation({ scope, plan, onConfirm, onClose }: { scope: StructureScope; plan: NonNullable<StructurePlansState['confirmation']>; onConfirm: () => void; onClose: () => void }) {
  const dialog = React.useRef<HTMLDivElement>(null), cancel = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => { const previous = document.activeElement as HTMLElement | null; cancel.current?.focus(); return () => previous?.focus?.(); }, []);
  return createPortal(<div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 p-4 animate-in fade-in duration-150" onClick={onClose}>
    <div ref={dialog} role="dialog" aria-modal="true" aria-label="确认 AI 拼结构" className="w-full max-w-[420px] rounded-xl border border-[var(--border)] bg-[var(--dock-pane)] p-4 text-[12px] text-[var(--text)] shadow-xl animate-in fade-in zoom-in-95 duration-150" onClick={event => event.stopPropagation()} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (event.key === 'Tab') { const buttons = dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'); if (!buttons?.length) return; const first = buttons[0]!, last = buttons[buttons.length - 1]!; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } }
    }}>
      <strong className="text-[14px]">{plan.continuation ? '继续 AI 拼结构' : 'AI 拼结构'}</strong>
      <p className="mt-3">仅使用当前这一次商品讲解{scope.startMs != null ? `：${sourceTime(scope.startMs)}–${sourceTime(scope.endMs ?? 0)}` : ''}</p>
      <p className="mt-2">发送已有话术、转写文字和已保存的核查记录，由 AI 选择片段与顺序。</p>
      {plan.rulesVersion === 'ai-structure-plans-v2' && <p className="mt-2">复用已有转写和分析，从长话术中选取保留必要上下文的完整小段，按 1.3 倍速组成 30～40 秒视频。旧方案和个人草稿保留。</p>}
      <p className="mt-2">新增 1 次文字模型请求，可能计费；{plan.continuation ? '已保存方案保留，本次继续补充。' : '已有分析直接复用。'}</p>
      <p className="mt-2">模型：{plan.service?.model || '未配置'}</p>
      <p className="mt-2">{plan.visibility === 'shared' ? '结果保存为公共方案，供同事复用。' : '结果保存在本机工程。'}个人草稿分别保存。</p>
      <details className="mt-3 text-[var(--text-muted)]"><summary className="cursor-pointer">请求详情</summary><div className="mt-2 space-y-1 break-all animate-in fade-in duration-150"><p>发送至：{plan.service?.endpoint || '未配置'}</p><p>话术 {plan.candidateCount ?? 0} 段 · 转写 {plan.transcriptSegments ?? 0} 条</p></div></details>
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
    if (currentRules.current !== version) { setPreview(null); setGroup(''); }
    currentRules.current = version; setRulesVersion(version); setPlans(next);
  };
  const [folder, setFolder] = React.useState('');
  const [projectTitle, setProjectTitle] = React.useState('结构视频');
  const [error, setError] = React.useState(''), [working, setWorking] = React.useState(false), [switching, setSwitching] = React.useState(false);
  const [plansOpen, setPlansOpen] = React.useState(true);
  const [group, setGroup] = React.useState('');
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
    const token = ++request.current; generation.current += 1; setWorking(false); setPlans(null); setPreview(null); setGroup(''); setConfirmation(null); currentRules.current = undefined; setRulesVersion(undefined);
    if (!scope) return;
    const composeOnLoad = composeAfterSelection.current === scopeKey(scope); composeAfterSelection.current = '';
    void api.structurePlans(projectId, scope).then(value => { if (request.current !== token) return; acceptPlans(value); if (composeOnLoad && value.confirmation && (value.status === 'idle' || value.canContinue)) setConfirmation({ scope, plan: value.confirmation }); }, e => { if (request.current === token) setError(String(e.message ?? e)); });
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
  const compose = async (selected: StructureScope, version = currentRules.current, preserveUntilConfirmed = false) => {
    showPlans(); setError('');
    // A card click carries the exact lecture even if React has not yet applied its selection.
    if (scopeKey(currentScope.current) !== scopeKey(selected)) { composeAfterSelection.current = scopeKey(selected); onScope(selected); return; }
    const token = ++generation.current; request.current += 1; setWorking(true);
    try {
      const next = await api.structurePlans(projectId, selected, version);
      if (generation.current !== token) return;
      const needsConfirmation = (next.status === 'idle' || (!preserveUntilConfirmed && next.canContinue)) && next.confirmation;
      // Looking at a new request is read-only. Cancelling keeps the old list;
      // already saved colleague results can be displayed immediately.
      if (!preserveUntilConfirmed || !needsConfirmation) acceptPlans(next, version);
      if (needsConfirmation) setConfirmation({ scope: selected, plan: next.confirmation! });
    } catch (e) { if (generation.current === token) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (generation.current === token) setWorking(false); }
  };
  const selectRules = async (version: string) => {
    const selected = currentScope.current; if (!selected) return;
    const token = ++generation.current; request.current += 1; setWorking(true); setError(''); setConfirmation(null);
    try { const next = await api.structurePlans(projectId, selected, version); if (generation.current === token) acceptPlans(next, version); }
    catch (e) { if (generation.current === token) setError(e instanceof Error ? e.message : String(e)); }
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
  const localPlans = plans?.context?.visibility === 'local';
  const planTitle = localPlans ? '本机方案' : '公共方案';
  const detailIssues = (plans?.issues ?? []).slice(plans?.status === 'unavailable' ? 1 : 0);
  const shown = group ? groups.find(item => item.key === group)?.plans ?? [] : plans?.plans ?? [];
  const selectedIds = selectedStructurePlanIds(plans?.plans ?? [], selectedPlans);
  const exportSelected = async (options: StructureBatchExportOptions) => {
    if (!scope || !plans?.taskKey || plans.status !== 'complete' || !selectedIds.length || switchLock.current) throw new Error('请等待保存完成后，重新勾选已保存的方案');
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
  const ruleOptions = [...new Set([...(plans?.savedVersions ?? []).map(item => item.version), ...(rulesVersion ? [rulesVersion] : [])])];
  const draftLabel = activeDraft ? structureDraftLabel(activeDraft.planId, plans?.plans ?? []) : undefined;
  const bridge: StructureEditorBridge = { ownerId: projectId, scope, rightWidth: plansVisible ? 350 : 0, preview, previewRequest, previewFolder: folder, onScope, onCompose: selected => void compose(selected), onClosePreview: closePreview, onShowPlans: showPlans, registerSave, onReturnToProject: () => void switchTo(null), draftLabel,
    batchExport: selectedIds.length ? { projectId, title: projectTitle, ordinals: (plans?.plans ?? []).flatMap((plan, index) => selectedPlans.has(plan.id) ? [index + 1] : []), onExport: exportSelected } : undefined };
  return <div data-active-structure-draft={active} inert={!!confirmation}>
    {workspace && <div inert={switching} aria-busy={switching}><ProjectView key={active} projectId={active} onProject={onProject} onLeave={onLeave} structure={bridge} /></div>}
    {!workspace && <div className="p-6 text-[13px]">正在读取工程与个人草稿…</div>}
    <aside aria-label={localPlans ? '本机结构方案' : '公共结构方案'} className={`fixed z-40 flex flex-col rounded-xl border border-[var(--border)] bg-[var(--dock-pane)] text-[var(--text)] shadow-lg transition-all duration-200 ${plansVisible ? 'opacity-100' : 'pointer-events-none translate-x-4 opacity-0'}`} style={{ top: 40, right: 8, bottom: 8, width: 334 }} aria-hidden={!plansVisible} inert={!plansVisible}>
      <div className="flex items-center gap-2 border-b border-[var(--border)] p-3"><ListVideo size={16} /><strong className="flex-1 text-[13px]">{planTitle}</strong><button aria-label="收起方案" className={button} onClick={() => setPlansOpen(false)}><X size={14} /></button></div>
      <div className="border-b border-[var(--border)] p-3 text-[12px]">
        <p>{draftLabel ? `下方编辑：${draftLabel}` : '下方编辑：已有成片'}</p>
        {workspace && workspace.drafts.length > 0 && <div className="mt-2 flex gap-1"><select aria-label="我的独立草稿" className="min-w-0 flex-1 rounded bg-[var(--surface)] p-1" value={active} disabled={switching} onChange={e => void switchTo(e.target.value)}><option value={projectId}>已有成片</option>{workspace.drafts.map(draft => <option key={draft.projectId} value={draft.projectId}>{structureDraftLabel(draft.planId, plans?.plans ?? [])}</option>)}</select>{activeDraft && <button className={button} disabled={switching} onClick={() => void switchTo(null)}>返回已有成片</button>}</div>}
        <p className="mt-2 text-[11px] text-[var(--text-muted)]">预览不改成片 · 编辑副本打开自己的独立草稿</p>
      </div>
      <div className="p-3 text-[12px]">
        {!scope ? <p>先在左侧选择一次商品讲解</p> : <>
          <p className="text-[var(--text-muted)]">本次讲解 {scope.startMs != null ? `${sourceTime(scope.startMs)}–${sourceTime(scope.endMs ?? 0)}` : ''}</p>
          {localPlans && <p className="mt-1 text-[11px] text-[var(--text-muted)]">复用已保存的本机分析 · 方案仅保存在本工程，尚未共享</p>}
          {plans?.status === 'unavailable' && <p role="alert" className="mt-2 text-[var(--warn)]">暂时不能拼结构：{plans.issues?.[0]?.message ?? '当前话术信息不足，请核对已有分析'}</p>}
          <p className="mt-1">{plans?.generationMethod === 'ai' ? `AI 方案 ${plans.plans.length} 条${plans.canContinue ? ' · 本轮尚未梳理完' : ''}` : `已保存 ${plans?.plans.length ?? 0} 条方案`}</p>
          <p className="mt-1 text-[11px] text-[var(--text-muted)]">{plans?.plans.length && plans.plans.every(plan => plan.speed === 1) ? '30～50 秒供参考，按原速保留完整表达；请预览检查衔接' : '1.3 倍速成片 30～40 秒，保留完整表达；请预览检查衔接'}</p>
          {plans && <details className="mt-1 text-[11px] text-[var(--text-muted)]" aria-label="方案复用的音画核查"><summary className="cursor-pointer transition-colors hover:text-[var(--accent)]">{mediaReview.summary}</summary><div className="mt-1 max-h-36 overflow-auto animate-in fade-in slide-in-from-top-1 duration-150">
            {mediaReview.originLabel && <p>{mediaReview.originLabel}</p>}{mediaReview.range && <p>{mediaReview.rangeLabel}：{mediaReview.range}</p>}<p>{mediaReview.note}</p>
            {mediaReview.segments.map((segment, index) => <div key={index} className="mt-2"><p>{segment.range}</p><p>{segment.visual}</p><p>{segment.audio}</p>{segment.issues.map((issue, i) => <p key={i} className="text-[var(--warn)]">{issue}</p>)}</div>)}
            {mediaReview.issues.map((issue, index) => <p key={index} className="mt-1 text-[var(--warn)]">{issue}</p>)}
          </div></details>}
          {plans && <ProductVisualReviewDetails review={plans.visualReview} origin={plans.visualReviewOrigin ?? 'shared'} stale={plans.visualReviewStale} label="方案复用的 AI 看图核查" />}
          {ruleOptions.length > 1 && <label className="mt-2 flex items-center gap-2 text-[11px]">方案版本<select aria-label="方案版本" className="min-w-0 flex-1 rounded bg-[var(--surface)] p-1 transition" value={rulesVersion ?? ''} disabled={working || switching} onChange={event => void selectRules(event.target.value)}>{ruleOptions.map(version => <option key={version} value={version}>{version === 'ai-structure-plans-v2' ? '新版 · 完整小段 · 1.3倍' : version === 'ai-structure-plans-v1' ? '旧版 · 完整话术 · 原速' : version}</option>)}</select></label>}
          {plans?.status === 'complete' && rulesVersion && plans.currentRulesVersion && rulesVersion !== plans.currentRulesVersion && <button className={`${button} mt-2`} disabled={working || switching} onClick={() => void compose(scope, plans.currentRulesVersion, true)}>按新版规则拼一版</button>}
          {(plans?.status === 'idle' || plans?.canContinue) && <button className={`${button} mt-2`} disabled={working} onClick={() => void compose(scope)}>{working ? '正在读取…' : plans.canContinue ? '继续 AI 拼结构' : '拼结构'}</button>}
          {plans?.status === 'busy' && <p className="mt-2">公共任务正在处理或等待恢复，未重复生成</p>}
          {plans?.status === 'running' && <p className="mt-2 text-[var(--text-muted)]">AI 正在拼结构，返回后自动保存；切换或重开只读取进度，不重复发送</p>}
          {plans?.generationMethod === 'ai' && plans.complete && <p className="mt-1 text-[11px] text-[var(--text-muted)]">已保存 AI 返回的有效方案，未宣称穷尽所有组合</p>}
          {plans?.status === 'failed' && <p role="alert" className="mt-2 text-[var(--warn)]">本次请求未完成，请核查下方原因；没有自动重发</p>}
          {plans?.status === 'failed' && plans.recoverable && <button className={`${button} mt-2`} disabled={working} onClick={async () => { const selected = scope, version = currentRules.current, token = ++generation.current; setWorking(true); try { const next = await api.recoverStructurePlans(projectId, selected, version); if (token === generation.current) acceptPlans(next, version); } catch (e) { if (token === generation.current) setError(String(e)); } finally { if (token === generation.current) setWorking(false); } }}>恢复已保存返回</button>}
          {plans?.status === 'publish-pending' && <p className="mt-2 text-[var(--warn)]">本机结果已保留，公共保存尚未完成；补存只保存已有结果</p>}
          {plans?.status === 'publish-pending' && <button className={`${button} mt-2`} disabled={working} onClick={async () => { const selected = scope, token = ++generation.current; setWorking(true); try { await api.publishStructurePlans(projectId, selected.sourceId, plans.taskKey!); if (token === generation.current) await refreshPlans(selected); } catch (e) { if (token === generation.current) setError(String(e)); } finally { if (token === generation.current) setWorking(false); } }}>补存已有公共结果</button>}
          <button className={`${button} ml-2 mt-2`} disabled={working} onClick={() => void refreshPlans(scope)}>刷新读取</button>
        </>}
        {detailIssues.length ? <details className="mt-2" open={!plans?.plans.length}><summary className="cursor-pointer">需核对 {detailIssues.length} 项</summary><div className="max-h-44 overflow-auto">{detailIssues.map((issue, index) => <p key={index} className="mt-1 text-[var(--warn)]">{issue.startMs != null ? `${sourceTime(issue.startMs)}–${sourceTime(issue.endMs ?? issue.startMs)} ` : ''}{issue.message}{issue.text && <span className="block text-[var(--text-muted)]">原话：{issue.text}</span>}</p>)}</div><p className="mt-2 text-[var(--text-muted)]">沿用已有话术记录；缺信息不会自动重新分析</p></details> : null}
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
            <button aria-label={`查看方案 ${planLetter(number - 1)} 预览`} aria-pressed={selected} className="w-full rounded text-left transition duration-150 active:scale-[0.99]" onClick={() => openPreview(plan)}>
              <div className="flex items-center gap-2">
                <span className={`flex h-5 min-w-5 items-center justify-center rounded border px-1 text-[10px] ${selected ? 'border-[var(--accent)] bg-[var(--bg-hover)] text-[var(--accent)]' : 'border-[var(--border)] text-[var(--text-muted)]'}`}>{planLetter(number - 1)}</span>
                <strong className="min-w-0 flex-1 line-clamp-2 text-[12px] leading-4" title={card.title}>{card.title}</strong>
                <span className="shrink-0 text-[11px] font-semibold tabular-nums">{card.durationLabel}</span>
              </div>
              <p className="mt-1.5 line-clamp-2 text-[10px] leading-4 text-[var(--text-muted)]" title={card.fullCoreQuotes}>{card.subtitle}</p>
              <p className="mt-1 truncate text-[10px] leading-4 text-[var(--text-muted)]" title={card.fullHook}>{card.hook}</p>
            </button>
            <div aria-label="方案结构" className="mt-2.5 flex gap-1 overflow-x-auto pb-0.5">
              {card.blocks.map((block, index) => <button type="button" key={index} aria-label={`预览方案 ${number} 第 ${index + 1} 段 ${block.fullLabel}`} title={`点击预览 · ${block.fullLabel} · ${(block.durationMs / 1000).toFixed(1)}秒`} onClick={() => openPreview(plan, index)} className="flex h-6 min-w-[40px] items-center justify-center rounded-sm px-1 text-[9px] text-[var(--text-muted)] transition duration-150 hover:brightness-125 active:scale-95 focus-visible:outline-2 focus-visible:outline-[var(--accent)]" style={{ flexGrow: block.durationMs, flexBasis: 0, background: `color-mix(in srgb, ${block.color} 23%, transparent)` }}>{block.label}</button>)}
            </div>
            <p className="mt-2 line-clamp-2 min-h-8 text-[10px] leading-4 text-[var(--text-muted)]" title={card.summary}>{card.summary}</p>
            <div className="mt-2 flex flex-wrap items-center gap-1"><span className={chip}>{card.coreCount}个卖点</span><span className={chip}>{card.speedLabel}</span><span className={chip} style={!card.durationInRange ? { color: 'var(--warn)' } : undefined}>{card.durationHint}</span></div>
            <details className="group mt-1.5 text-[10px] text-[var(--text-muted)]">
              <summary className="cursor-pointer rounded py-0.5 transition hover:text-[var(--text)]">完整原话与来源 · {plan.clips.length}段</summary>
              <div className="mt-1 max-h-60 overflow-auto border-t border-[var(--border)] pb-1 animate-in fade-in slide-in-from-top-1 duration-150">{plan.clips.map((clip, index) => <button type="button" key={index} aria-label={`预览原话 ${number} 第 ${index + 1} 段`} title="点击跳到这段原片" onClick={() => openPreview(plan, index)} className="mt-2 block w-full rounded text-left text-[11px] leading-relaxed transition duration-150 hover:bg-[var(--bg-hover)] active:scale-[0.99] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"><span className="mb-0.5 block text-[var(--text-dim)]">{clip.roles.map(structureRole).join('/')} · {sourceTime(clip.startMs)}–{sourceTime(clip.endMs)}{clip.assetPath ? ` · ${clip.assetPath}` : ''}</span>{clip.text}</button>)}</div>
            </details>
            <div className="mt-auto grid grid-cols-2 gap-2 pt-2">
              <button aria-label={`预览方案 ${number}`} aria-pressed={selected} className={`${button} flex h-7 items-center justify-center gap-1 text-[10px]`} onClick={() => openPreview(plan)}>{selected ? <><span className="h-1 w-1 rounded-full bg-[var(--accent)]" />正在预览</> : <><Play size={11} />预览方案</>}</button>
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
    {!plansVisible && !host?.open && <button className={`${button} fixed right-3 top-10 z-50 bg-[var(--surface)]`} onClick={showPlans}><ListVideo size={14} className="mr-1 inline" />{planTitle}</button>}
    {confirmation && <StructureComposeConfirmation {...confirmation} onConfirm={() => void confirmComposition()} onClose={() => setConfirmation(null)} />}
  </div>;
}
