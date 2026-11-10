import React from 'react';
import { api } from '@/api';
import type { ProductWorkflowRequest, SharedResultVersion, SharedVersionGroup, SharedVersionsState } from '@/lib/product-workflow-types';
import { sourceTime } from '@/lib/product-analysis';
import { ProductWorkflowConfirmation } from './ProductWorkflowConfirmation';

const button = 'rounded border border-[var(--border)] px-2 py-1 text-[11px] transition duration-150 hover:bg-[var(--bg-hover)] active:scale-95 disabled:opacity-40';
const names = { transcription: '转写', discovery: '拆品', analysis: '话术' };

/** Inspection reads metadata only. Adoption and new paid analysis have distinct, explicit actions. */
export function ProductSharedVersions({ projectId, sourceId, refreshKey, onChanged }: {
  projectId: string; sourceId: string; refreshKey: string | number; onChanged: () => Promise<void>;
}) {
  const [state, setState] = React.useState<SharedVersionsState | null>(null);
  const [tick, setTick] = React.useState(0);
  const [error, setError] = React.useState('');
  const [message, setMessage] = React.useState('');
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<Record<string, string>>({});
  const [confirm, setConfirm] = React.useState<{ group: SharedVersionGroup; version: SharedResultVersion } | null>(null);
  const [request, setRequest] = React.useState<ProductWorkflowRequest | null>(null);
  const [busy, setBusy] = React.useState(false);
  const submitting = React.useRef(false);
  React.useEffect(() => {
    let active = true;
    void api.sharedAnalysisVersions(projectId, sourceId).then(value => { if (active) { setState(value); setError(''); } }, reason => {
      if (active) setError(String(reason.message ?? reason));
    });
    return () => { active = false; };
  }, [projectId, sourceId, refreshKey, tick]);
  const context = (group: SharedVersionGroup): ProductWorkflowRequest => ({ sourceId, action: group.action,
    ...(group.productId && group.intervalId ? { productId: group.productId, intervalId: group.intervalId } : {}) });
  const adopt = async () => {
    if (!confirm || submitting.current || !confirm.group.currentVersion) return;
    submitting.current = true; setBusy(true); setError(''); setMessage('');
    try {
      const result = await api.adoptSharedAnalysis(projectId, { ...context(confirm.group), versionTaskKey: confirm.version.taskKey,
        expectedCurrentSha: confirm.group.currentVersion.sha256, confirmed: true });
      setMessage([result.needsReview ? result.reason || '新版建议待核对，当前版本和人工修改保留；请在下方原始记录中核对并应用。' : '已采用所选共享版本，个人取用和成片保留', result.warning].filter(Boolean).join('。'));
      setConfirm(null); await onChanged(); setTick(value => value + 1);
    } catch (reason) { setError(String((reason as Error).message ?? reason)); setConfirm(null); }
    finally { submitting.current = false; setBusy(false); }
  };
  if (!state?.groups.length && !error) return null;
  return <section aria-label="共享分析版本" className="space-y-2 rounded border border-[var(--border)] p-2 text-[11px] transition-all duration-150 animate-in fade-in">
    <div className="flex items-center justify-between gap-2"><span>共享分析版本</span><button type="button" className={button} disabled={busy} onClick={() => setTick(value => value + 1)}>检查新版</button></div>
    <p className="text-[var(--text-muted)]">工程固定使用当前版本。查看新版不会重新分析或改变成片。</p>
    {state?.warning && <p role="status">{state.warning}</p>}
    {state?.groups.map(group => {
      const key = group.familyKey;
      const candidate = group.versions.find(v => v.taskKey === selected[key]) ?? group.latestVersion ?? group.currentVersion;
      const visible = expanded === key;
      return <div key={key} className="space-y-1 border-t border-[var(--border)] pt-2 transition-all duration-150">
        <div className="flex flex-wrap items-center gap-2"><span>{names[group.action]}</span><span>{group.currentVersion ? `当前 V${group.currentVersion.sequence}` : '尚未绑定'}</span>{group.updateAvailable && group.latestVersion && <span className="text-[var(--accent)]">发现 V{group.latestVersion.sequence}</span>}</div>
        {group.scope && <p>{sourceTime(group.scope.startMs)} – {sourceTime(group.scope.endMs)}</p>}
        {(group.reason || group.warning) && <p className="text-[var(--text-muted)]">{group.reason || group.warning}</p>}
        <div className="flex flex-wrap gap-1"><button type="button" className={button} disabled={busy} onClick={() => { setExpanded(visible ? null : key); setMessage(''); }}>查看可用版本</button>
          {group.canCreateVersion && <button type="button" className={button} disabled={busy || !!request} onClick={() => setRequest({ ...context(group), newVersion: true })}>生成共享新版</button>}</div>
        {visible && <div className="space-y-2 py-1 animate-in fade-in duration-150">
          <select aria-label="选择共享版本" className="w-full rounded bg-[var(--dock-pane)] p-1 transition" value={candidate?.taskKey ?? ''} disabled={busy} onChange={event => setSelected(value => ({ ...value, [key]: event.target.value }))}>
            {group.versions.map(version => <option key={version.taskKey} value={version.taskKey}>V{version.sequence}{version.model ? ` · ${version.model}` : ''}</option>)}
          </select>
          {candidate && <p className="break-all text-[var(--text-muted)]">结果标识 {candidate.sha256.slice(0, 12)}{candidate.createdAt ? ` · ${candidate.createdAt}` : ''}</p>}
          <button type="button" className={button} disabled={busy || !candidate || !group.currentVersion || candidate.taskKey === group.currentVersion.taskKey} onClick={() => { if (candidate) { setError(''); setMessage(''); setConfirm({ group, version: candidate }); } }}>采用所选版本</button>
        </div>}
      </div>;
    })}
    {confirm && <div role="dialog" aria-label="确认采用共享版本" className="space-y-2 rounded border border-[var(--accent)]/40 p-2 animate-in fade-in duration-150">
      <p>将检查并采用 V{confirm.version.sequence}，不发送模型请求。原版本留存，个人取用与成片不变；人工修正存在冲突时先核对，不静默覆盖。</p>
      <div className="flex gap-1"><button type="button" className={button} disabled={busy} onClick={() => void adopt()}>确认采用</button><button type="button" className={button} disabled={busy} onClick={() => setConfirm(null)}>保留当前版本</button></div>
    </div>}
    {request && <ProductWorkflowConfirmation projectId={projectId} request={request} onClose={() => { setRequest(null); setTick(value => value + 1); }} onDone={async () => { await onChanged(); setTick(value => value + 1); }} />}
    {message && <p role="status">{message}</p>}
    {error && <p role="alert" className="text-red-400">{error}</p>}
  </section>;
}
