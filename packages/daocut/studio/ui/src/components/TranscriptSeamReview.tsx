import React from 'react';
import { api, ApiError, type TranscriptCue, type TranscriptReviewState, type TranscriptSeam } from '@/api';
import { sourceTime } from '@/lib/product-analysis';

const button = 'rounded border border-[var(--border)] px-2 py-1.5 text-[11px] transition duration-150 hover:bg-[var(--bg-hover)] active:scale-95 disabled:opacity-40';
const input = 'min-w-0 w-full rounded border border-[var(--border)] bg-[var(--dock-pane)] px-2 py-1 transition focus:border-[var(--accent)] focus:outline-none';
type Draft = { text: string; from: string; to: string };
const draftsOf = (cues: TranscriptCue[]): Draft[] => cues.map(cue => ({ text: cue.text, from: String(cue.startMs / 1000), to: String(cue.endMs / 1000) }));
const seamVersion = (seam?: TranscriptSeam) => JSON.stringify(seam && { status: seam.status, cues: seam.resolved ?? seam.proposed });

/** Local review only: neither opening, seeking nor saving submits an ASR/model task. */
export function TranscriptSeamReview({ projectId, sourceId, refreshKey, openRequest = 0, onLocate, onSaved }: {
  projectId: string; sourceId: string; refreshKey: string; openRequest?: number;
  onLocate: (sourceId: string, ms: number, candidateId?: string, play?: boolean) => void;
  onSaved: () => Promise<void>;
}) {
  const [state, setState] = React.useState<TranscriptReviewState | null>(null);
  const [open, setOpen] = React.useState(false);
  const [selected, setSelected] = React.useState('');
  const [drafts, setDrafts] = React.useState<Record<string, Draft[]>>({});
  const draftBases = React.useRef<Record<string, { identity: string; revision: number; seamVersion?: string }>>({});
  const [acknowledged, setAcknowledged] = React.useState(false);
  const [error, setError] = React.useState('');
  const [saved, setSaved] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [conflict, setConflict] = React.useState(false);
  const [tick, setTick] = React.useState(0);
  const saving = React.useRef(false);
  const toggle = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    if (!openRequest || !state?.available) return;
    setOpen(true);
    const frame = requestAnimationFrame(() => {
      toggle.current?.focus({ preventScroll: true });
      toggle.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    return () => cancelAnimationFrame(frame);
  }, [openRequest, state?.available]);
  React.useEffect(() => {
    let active = true;
    void api.transcriptReview(projectId, sourceId).then(value => {
      if (!active) return;
      setState(value);
      if (value.available) setSelected(current => value.seams.some(seam => seam.id === current) ? current : (value.seams.find(seam => seam.status === 'pending') ?? value.seams[0])?.id ?? '');
    }, reason => { if (active) setError(String(reason.message ?? reason)); });
    return () => { active = false; };
  }, [projectId, sourceId, refreshKey, tick]);
  const seam = state?.available ? state.seams.find(item => item.id === selected) : undefined;
  const draft = drafts[selected] ?? draftsOf(seam?.resolved ?? seam?.proposed ?? []);
  const setDraft = (next: Draft[]) => {
    if (state?.available && !draftBases.current[selected]) draftBases.current[selected] = { identity: state.identity, revision: state.revision, seamVersion: seamVersion(seam) };
    setDrafts(current => ({ ...current, [selected]: next })); setSaved('');
  };
  const choose = (cues: TranscriptCue[]) => setDraft(draftsOf(cues));
  const reload = () => { setDrafts({}); draftBases.current = {}; setConflict(false); setAcknowledged(false); setError(''); setSaved(''); setTick(value => value + 1); };
  const save = async () => {
    if (saving.current || !state?.available || !seam || conflict || !acknowledged) return;
    const cues = draft.map(row => ({ text: row.text.trim(), startMs: Math.round(Number(row.from) * 1000), endMs: Math.round(Number(row.to) * 1000) }));
    if (draft.some(row => !row.from.trim() || !row.to.trim()) || cues.some((cue, index) => !cue.text || !Number.isFinite(cue.startMs) || !Number.isFinite(cue.endMs) || cue.startMs < seam.startMs || cue.endMs > seam.endMs || cue.startMs >= cue.endMs || (index > 0 && cue.startMs < cues[index - 1].startMs))) {
      setError('请填写原话和有效起止时间，按时间顺序排列，并保持在本接缝范围内。'); return;
    }
    saving.current = true; setBusy(true); setError(''); setSaved('');
    const base = draftBases.current[seam.id] ?? { identity: state.identity, revision: state.revision };
    try {
      const next = await api.saveTranscriptSeam(projectId, { sourceId, identity: base.identity, expectedRevision: base.revision, seamId: seam.id, cues, confirmed: true, acknowledgeImpact: acknowledged });
      // A background GET never rebases drafts. After a save, only unchanged other seams may advance.
      if (next.available) for (const [id, pending] of Object.entries(draftBases.current)) {
        if (pending.identity === next.identity && pending.seamVersion === seamVersion(next.seams.find(item => item.id === id))) pending.revision = next.revision;
      }
      delete draftBases.current[seam.id];
      setState(next); setDrafts(current => { const copy = { ...current }; delete copy[seam.id]; return copy; });
      setSaved(next.available && next.complete ? '已保存，当前转写可用；后续分析不会自动启动。' : '本接缝已保存，可继续核对其余接缝。');
      setAcknowledged(false);
      try { await onSaved(); } catch { setError('接缝已保存，但页面状态刷新失败。请重新读取接缝。'); }
    } catch (reason) {
      setConflict(reason instanceof ApiError && reason.status === 409);
      setError(`接缝未确认保存：${reason instanceof Error ? reason.message : String(reason)}。草稿保留；重试只保存本地，不请求转写。`);
    } finally { saving.current = false; setBusy(false); }
  };
  if (!state?.available) return error ? <p role="alert" className="text-[11px] text-[var(--warn)]">字幕接缝状态暂不可读：{error} <button type="button" className={button} onClick={reload}>重新读取接缝</button></p> : null;
  const raw = (cues: TranscriptCue[], label: string) => <div className="space-y-1 rounded border border-[var(--border)] p-2"><strong>{label}识别</strong>{cues.length ? cues.map((cue, index) => <button type="button" key={index} aria-label={`定位${label}字幕 ${index + 1}`} onClick={() => onLocate(sourceId, cue.startMs)} className="block w-full rounded p-1 text-left transition hover:bg-[var(--bg-hover)] active:scale-[.99]"><span className="block tabular-nums text-[var(--accent)]">{sourceTime(cue.startMs)} – {sourceTime(cue.endMs)}</span><span className="block whitespace-pre-wrap break-words">{cue.text}</span></button>) : <p className="text-[var(--text-muted)]">此段没有对应识别文字</p>}</div>;
  return <div className="border-t border-[var(--border)] pt-2 text-[11px]">
    <button ref={toggle} type="button" className={button} aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? '收起衔接记录' : '字幕衔接记录'}</button>
    <span className="ml-2 text-[var(--text-muted)]">{state.pendingCount ? `待处理 ${state.pendingCount} 处` : '已自动衔接'}</span>
    <div className={`grid transition-[grid-template-rows,opacity] duration-200 ${open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`} inert={!open} aria-hidden={!open}>
      <div className="min-h-0 overflow-hidden"><section aria-label="字幕接缝核对" className="space-y-2 pt-2">
        <p>两边原始识别保留。这里只核对字幕，不重新上传音频。</p>
        {state.legacyReview && <p className="text-[var(--warn)]">历史复核记录：{state.legacyReview}。保留原有结果，不作为本次人工确认。</p>}
        <label className="block">选择接缝<select aria-label="选择接缝" className={`${input} mt-1`} disabled={busy} value={selected} onChange={event => { setSelected(event.target.value); setAcknowledged(false); setError(''); setSaved(''); }}>{state.seams.map((item, index) => <option key={item.id} value={item.id}>{index + 1} · {sourceTime(item.boundaryMs)} · {{ pending: '待核对', automatic: '已自动衔接', confirmed: '已人工确认' }[item.status]}</option>)}</select></label>
        {seam && <>
          <p className="text-[var(--text-muted)]">{seam.reason}</p>
          <p>原片范围：{sourceTime(seam.startMs)} – {sourceTime(seam.endMs)}</p>
          <button type="button" className={button} onClick={() => onLocate(sourceId, Math.max(0, seam.startMs - 2000), undefined, true)}>播放接缝原片</button>
          {raw(seam.left, '前段')}{raw(seam.right, '后段')}
          <div className="flex flex-wrap gap-1"><button type="button" className={button} disabled={busy || !seam.left.length} onClick={() => choose(seam.left)}>采用前段</button><button type="button" className={button} disabled={busy || !seam.right.length} onClick={() => choose(seam.right)}>采用后段</button><button type="button" className={button} disabled={busy} onClick={() => choose([...seam.left, ...seam.right].sort((a, b) => a.startMs - b.startMs))}>保留两边</button></div>
          <strong className="block">最终采用</strong>
          {!draft.length && <p className="text-[var(--warn)]">当前没有保留字幕行。确认保存将表示此接缝没有有效字幕，原始识别仍保留。</p>}
          <p className="text-[var(--text-muted)]">时间为原片秒数。跨接缝的句子可保留完整；也可编辑一行并移除多余行。</p>
          <div className="space-y-2">{draft.map((row, index) => <div key={index} className="space-y-1 rounded border border-[var(--border)] p-2">
            <div className="flex gap-1"><label className="min-w-0 flex-1">开始秒<input type="number" step="0.001" aria-label={`开始秒 ${index + 1}`} className={input} disabled={busy} value={row.from} onChange={event => setDraft(draft.map((value, i) => i === index ? { ...value, from: event.target.value } : value))} /></label><label className="min-w-0 flex-1">结束秒<input type="number" step="0.001" aria-label={`结束秒 ${index + 1}`} className={input} disabled={busy} value={row.to} onChange={event => setDraft(draft.map((value, i) => i === index ? { ...value, to: event.target.value } : value))} /></label></div>
            <textarea aria-label={`字幕文字 ${index + 1}`} className={`${input} min-h-16 resize-y`} disabled={busy} value={row.text} onChange={event => setDraft(draft.map((value, i) => i === index ? { ...value, text: event.target.value } : value))} />
            <div className="flex gap-1"><button type="button" className={button} aria-label={`定位最终字幕 ${index + 1}`} disabled={!row.from.trim() || !Number.isFinite(Number(row.from)) || Number(row.from) < 0 || Number(row.from) * 1000 > state.source.durationMs} onClick={() => onLocate(sourceId, Math.round(Number(row.from) * 1000))}>定位原片</button><button type="button" className={button} aria-label={`移除最终字幕 ${index + 1}`} disabled={busy} onClick={() => setDraft(draft.filter((_, i) => i !== index))}>移除此行</button></div>
          </div>)}</div>
          <button type="button" className={button} disabled={busy} onClick={() => setDraft([...draft, { text: '', from: String(seam.startMs / 1000), to: String(seam.endMs / 1000) }])}>添加字幕行</button>
          <div className="rounded border border-[var(--border)] p-2 text-[var(--text-muted)]">
            <p>全部接缝确认后更新转写版本；旧分析与人工修改保留，不会自动重新分析。</p>
            {state.impact.discovery && <p>本视频已有拆品结果可能需要重新分析。</p>}
            {state.impact.ranges.length > 0 && <details><summary>可能受影响的话术范围 · {state.impact.ranges.length} 段</summary>{state.impact.ranges.map(range => <p key={`${range.productId}:${range.intervalId}`}>{range.productName} · {sourceTime(range.startMs)} – {sourceTime(range.endMs)}</p>)}</details>}
            <p>人工确认区域不沿用旧的逐词对齐；分析边界请落在完整句边。</p>
          </div>
          <label className="flex items-start gap-2"><input type="checkbox" aria-label="已知悉字幕修改影响" disabled={busy} checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} />已核对最终文字和时间，并知悉对后续分析的影响</label>
          <button type="button" className={button} disabled={busy || conflict || !acknowledged} onClick={() => void save()}>{busy ? '正在保存…' : '确认并保存接缝'}</button>
        </>}
        {saved && <p role="status" className="text-[var(--accent)]">{saved}</p>}
        {error && <p role="alert" className="text-[var(--warn)]">{error} <button type="button" disabled={busy} className={button} onClick={reload}>重新读取接缝</button></p>}
      </section></div>
    </div>
  </div>;
}
