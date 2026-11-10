import React from 'react';
import { applyOps } from '../../../server/ops.mjs';
import type { Film, Op } from '@/api';
import { filmShape } from '@/lib/film-shape';
import type { FilmDoc } from '@/lib/film';
import { layoutTracks, type TimelineBlock, type TimelineTrack } from '@/lib/timeline-layout';
import { stackSourceTracks } from '@/lib/source-timeline-layout';
import { MAIN_TRACK_H } from '@/lib/track-heights';
import { splitHalves } from '@/lib/timeline-split';
import { prepareSourceTakes, sourceTakeSignature, sourceTakeState, editSourceTakes, focusSourceTake, retrySourceTakeSave, useSourceTakeVersion } from '@/lib/source-take-store';
import { keyAction } from '@/lib/keymap-store';
import { structureColor, structureGradient } from '@/lib/structure-colors';
import { displayStructureTags, hasStructureTag } from '@/lib/product-structure-tags';
import { ladderStepMs, THUMB_CELL_PX } from '@/lib/thumb-cache';
import { useLoadedThumbs } from '@/lib/use-loaded-thumbs';
import { formatTimecode } from '@/lib/timecode';
import type { SourceProductRange } from './SourcePreview';
import { Timeline, timelineFitHeight, type TimelineCommands, type TimelineProps } from './Timeline';
import { SourceProductMarkers } from './SourceProductMarkers';

type TakeRange = { startMs: number; endMs: number };
export type SourceTakeRange = TakeRange & { sourceId: string; label: string; candidateId?: string };
const SOURCE_BLOCK_DEFAULT = MAIN_TRACK_H;
const SOURCE_HEIGHT_KEY = 'daocut:source-track-height';
type Props = {
  sourceId: string; duration: number; time: number; ranges: SourceProductRange[]; selectedProductId?: string | null; selectedIntervalId?: string | null;
  selectedCandidateId?: string | null; selectedTag?: string; candidateSelectionTick?: number;
  focusRangeRequest?: number;
  onSelectRange?: (range: SourceProductRange) => void; onSeek: (seconds: number) => void;
  onTrimProductRange?: (range: SourceProductRange, bounds: TakeRange) => Promise<void>;
  onDragCandidate?: (id: string, event: React.DragEvent, range?: TakeRange) => void;
  onDragCandidateEnd?: () => void; canDragCandidate?: (id: string) => boolean;
  onDragSourceRange?: (range: { sourceId: string; startMs: number; endMs: number }, event: React.DragEvent) => void;
  sourceDragAvailable?: boolean; thumbnail?: { projectId: string; path: string; version?: number };
  rightInset?: number; headWidth?: number;
  onCopySource?: (blocks: readonly TimelineBlock[], tracks: readonly TimelineTrack[], film: Film) => void;
  active?: boolean; onActivate?: () => void;
  onSelectTakeRange?: (range: SourceTakeRange | null) => void;
  onPreviewRange?: (range: SourceTakeRange) => void;
  onResolveCandidateTake?: (range: SourceTakeRange) => void;
  clearSelectionTick?: number;
};

function read<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback; } catch { return fallback; }
}

/** Private takes live in the project, independently of AI results and the finished film. */
export function SourceTimeline(props: Props) {
  const version = useSourceTakeVersion();
  const projectId = props.thumbnail?.projectId ?? '';
  const totalMs = Math.max(0, Math.round(props.duration * 1000));
  const source = { projectId, sourceId: props.sourceId, assetPath: props.thumbnail?.path ?? props.sourceId, durationMs: totalMs, version: props.thumbnail?.version };
  const signature = sourceTakeSignature(source, props.ranges);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [retry, setRetry] = React.useState(0);
  const state = sourceTakeState(projectId, props.sourceId);
  React.useEffect(() => {
    if (!projectId || totalMs <= 0 || state?.moving) return;
    let cancelled = false; setLoadError(null);
    void prepareSourceTakes(source, props.ranges).catch(error => { if (!cancelled) setLoadError(String(error.message ?? error)); });
    return () => { cancelled = true; };
  }, [projectId, props.sourceId, signature, props.thumbnail?.version, retry, state, state?.moving]);
  const error = loadError ?? state?.error;
  const ready = state?.document?.signature === signature;
  void version;
  return <>
    <div data-source-take-save-state={error ? 'error' : state?.saving ? 'saving' : ready ? 'saved' : 'loading'} role={error ? 'alert' : 'status'} className={`flex items-center gap-2 px-3 text-[11px] transition-colors ${error ? 'text-red-400' : 'text-[var(--text-muted)]'}`}>
      <span>{error ?? (state?.saving ? '正在保存取用…' : ready ? state?.persisted ? '取用已保存在工程' : '取用就绪，修改后自动保存' : '正在读取取用…')}</span>
      {error ? <button type="button" onClick={() => void retrySourceTakeSave(projectId, props.sourceId).then(() => { setLoadError(null); setRetry(n => n + 1); })} className="rounded px-2 py-1 transition hover:bg-[var(--bg-hover)] active:scale-95">重试保存取用</button> : null}
    </div>
    {ready ? <SourceTimelineEditor key={JSON.stringify([projectId, props.sourceId, signature])} {...props} totalMs={totalMs} initial={state!.document!.film} /> : null}
  </>;
}

function SourceTimelineEditor({ sourceId, duration, time, ranges, selectedProductId, selectedIntervalId, selectedCandidateId, selectedTag = '全部', candidateSelectionTick, focusRangeRequest, onSelectRange, onSeek, onTrimProductRange, onDragCandidate, onDragCandidateEnd, canDragCandidate, onDragSourceRange, sourceDragAvailable = false, thumbnail, rightInset = 0, headWidth = 132, onCopySource, active, onActivate, onSelectTakeRange, onPreviewRange, onResolveCandidateTake, clearSelectionTick, totalMs, initial }: Props & { totalMs: number; initial: Film }) {
  const src = thumbnail?.path ?? sourceId;
  const projectId = thumbnail?.projectId ?? '';
  const [film, setFilm] = React.useState(initial);
  const [history, setHistory] = React.useState<{ done: Film[]; undone: Film[] }>({ done: [], undone: [] });
  const historyRef = React.useRef(history); historyRef.current = history;
  const current = React.useRef(film); current.current = film;
  const clips = film.tracks.flatMap(track => track.clips);
  const byId = React.useMemo(() => new Map(clips.map(clip => [clip.id, clip])), [film]);
  const rangeById = React.useMemo(() => new Map(ranges.filter(r => r.sourceId === sourceId && r.kind === 'candidate').map(r => [r.id, r])), [ranges, sourceId]);
  const [blockHeight, setBlockHeight] = React.useState(() => {
    const saved = read<unknown>(SOURCE_HEIGHT_KEY, SOURCE_BLOCK_DEFAULT);
    return typeof saved === 'number' && Number.isFinite(saved) ? Math.max(68, Math.min(160, saved)) : SOURCE_BLOCK_DEFAULT;
  });
  const layout = React.useMemo(() => stackSourceTracks(layoutTracks(filmShape(film as unknown as FilmDoc, [], new Map([[src, { duration, audio: true }]]))), blockHeight), [film, src, duration, blockHeight]);
  const tracks = layout.tracks;
  const blocks = tracks.flatMap(track => track.blocks);
  const [selectedClipIds, setSelectedClipIds] = React.useState<readonly string[]>([]);
  const [focusedClipId, setFocusedClipId] = React.useState<string | null>(null);
  React.useEffect(() => { focusSourceTake(projectId, sourceId, focusedClipId ?? undefined); }, [projectId, sourceId, focusedClipId]);
  const filterKey = JSON.stringify([selectedProductId ?? null, selectedTag]);
  const [selectionFilterKey, setSelectionFilterKey] = React.useState(filterKey);
  const [selectionRevision, setSelectionRevision] = React.useState(0);
  const externalSelection = React.useRef<string | null>(null);
  const selectedClip = focusedClipId && selectedClipIds.includes(focusedClipId) ? byId.get(focusedClipId) : undefined;
  const selectedRange = selectedClip ? rangeById.get(selectedClip.attrs?.['data-source-range'] ?? '') : undefined;
  const selectedLabel = selectedRange ? displayStructureTags(selectedRange.tags ?? []).join(' · ') || '候选' : selectedClip?.attrs?.['data-source-kind'] === 'take' ? '保留取用' : '原片';
  const take = selectedClip?.time?.length === 2 ? { sourceId, startMs: Math.round(selectedClip.time[0] * 1000), endMs: Math.round(selectedClip.time[1] * 1000), label: selectedLabel, candidateId: selectedRange?.id } : null;
  const onSelectTakeRef = React.useRef(onSelectTakeRange); onSelectTakeRef.current = onSelectTakeRange;
  const hadTake = React.useRef(false);
  const lastClearTick = React.useRef(clearSelectionTick);
  React.useEffect(() => {
    if (lastClearTick.current === clearSelectionTick) return;
    lastClearTick.current = clearSelectionTick;
    hadTake.current = false; externalSelection.current = null;
    setSelectedClipIds([]); setFocusedClipId(null);
  }, [clearSelectionTick]);
  React.useEffect(() => {
    if (take && selectedClip?.id === externalSelection.current) { externalSelection.current = null; hadTake.current = true; return; }
    if (take || hadTake.current) onSelectTakeRef.current?.(take);
    hadTake.current = Boolean(take);
  }, [sourceId, selectedClip?.id, take?.startMs, take?.endMs, take?.label, take?.candidateId, selectionRevision]);
  const lastCandidateRequest = React.useRef<{ tick: number | undefined; initialized: boolean }>({ tick: candidateSelectionTick, initialized: false });
  React.useEffect(() => {
    const first = !lastCandidateRequest.current.initialized;
    const explicit = lastCandidateRequest.current.tick !== candidateSelectionTick;
    lastCandidateRequest.current = { tick: candidateSelectionTick, initialized: true };
    if (!selectedCandidateId) return;
    const focused = focusedClipId ? byId.get(focusedClipId) : undefined;
    const matches = focused?.attrs?.['data-source-range'] === selectedCandidateId;
    if (matches && !explicit && !first) return;
    const clip = matches ? focused : clips.find(item => item.attrs?.['data-source-range'] === selectedCandidateId);
    if (!clip) return;
    if (explicit || !matches) setSelectionFilterKey(filterKey);
    if (!matches) { externalSelection.current = clip.id; setFocusedClipId(clip.id); setSelectedClipIds([clip.id]); }
    if (clip.time?.length === 2) {
      const range = rangeById.get(selectedCandidateId);
      onResolveCandidateTake?.({ sourceId, startMs: Math.round(clip.time[0] * 1000), endMs: Math.round(clip.time[1] * 1000), label: displayStructureTags(range?.tags ?? []).join(' · ') || '候选', candidateId: selectedCandidateId });
    }
  }, [selectedCandidateId, candidateSelectionTick]);
  const hasProductMarkers = ranges.some(range => range.sourceId === sourceId && range.kind === 'interval');
  const [productFeedback, setProductFeedback] = React.useState<{ message: string; error?: boolean } | null>(null);
  const edit = React.useCallback(async (ops: Op[]) => {
    if (!ops.length) return null;
    try {
      const before = current.current;
      const after = applyOps(structuredClone(before), ops) as Film;
      for (const clip of after.tracks.flatMap(track => track.clips)) {
        if (!clip.time || clip.time.length !== 2 || clip.time[0] < 0 || clip.time[1] > totalMs / 1000 || clip.time[1] <= clip.time[0]) return '素材范围无效';
        clip.at = clip.time[0];
      }
      editSourceTakes(projectId, sourceId, after);
      current.current = after; setFilm(after); setHistory(h => ({ done: [...h.done, before], undone: [] }));
      return null;
    } catch (error) { return String(error); }
  }, [totalMs, projectId, sourceId]);
  const step = (kind: 'undo' | 'redo') => {
    const h = historyRef.current;
    const from = kind === 'undo' ? h.done : h.undone;
    const next = from[from.length - 1];
    if (!next) return;
    try { editSourceTakes(projectId, sourceId, next); } catch (error) { setProductFeedback({ message: String(error), error: true }); return; }
    const now = current.current; current.current = next; setFilm(next);
    const updated = kind === 'undo' ? { done: from.slice(0, -1), undone: [...h.undone, now] } : { done: [...h.done, now], undone: from.slice(0, -1) };
    historyRef.current = updated;
    setHistory(updated);
  };
  const split = (blocks: readonly TimelineBlock[], atMs: number) => {
    const ops: Op[] = blocks.flatMap(block => {
      const clip = block.clipId ? byId.get(block.clipId) : undefined;
      const halves = clip && splitHalves(block, atMs, clip.time?.[1]);
      return clip && halves ? [{ op: 'split' as const, clip: clip.id, left: halves.left, right: halves.right }] : [];
    });
    return ops.length ? edit(ops) : Promise.resolve('当前位置无法分割');
  };
  const [view, setView] = React.useState({ fromMs: 0, toMs: totalMs, pxPerMs: 0 });
  const frames = React.useMemo(() => {
    const result = new Map<string, string>();
    if (!thumbnail || !view.pxPerMs) return result;
    const step = ladderStepMs(THUMB_CELL_PX / view.pxPerMs);
    for (const clip of clips) {
      if (!clip.time || clip.time.length !== 2) continue;
      // Overview-sized blocks communicate structure by colour; don't fetch subpixel thumbnails.
      if ((clip.time[1] - clip.time[0]) * 1000 * view.pxPerMs < 12) continue;
      const from = Math.max(clip.time[0] * 1000, view.fromMs - step);
      const to = Math.min(clip.time[1] * 1000, view.toMs + step);
      for (let at = Math.floor(from / step) * step; at <= to; at += step) {
        const ms = Math.max(0, Math.round(at));
        result.set(`${thumbnail.version ?? 0}:${clip.id}@${ms}#v`, `/api/projects/${encodeURIComponent(thumbnail.projectId)}/media?what=frame&path=${encodeURIComponent(thumbnail.path)}&ms=${ms}&w=${THUMB_CELL_PX * 2}&v=${thumbnail.version ?? 0}`);
      }
    }
    return result;
  }, [film, thumbnail?.projectId, thumbnail?.path, thumbnail?.version, view]);
  const thumbs = useLoadedThumbs(frames);
  const rangeFor = (block: TimelineBlock) => {
    const clip = block.clipId ? byId.get(block.clipId) : undefined;
    return clip ? rangeById.get(clip.attrs?.['data-source-range'] ?? '') : undefined;
  };
  const appearance: NonNullable<TimelineProps['blockAppearance']> = (block) => {
    const range = rangeFor(block);
    const common = { 'data-source-start': String(block.startMs), 'data-source-end': String(block.endMs), 'data-source-level': '0', 'data-source-overlap': String(layout.overlaps.has(block.id)) };
    const selectedHere = selectionFilterKey === filterKey && !!block.clipId && selectedClipIds.includes(block.clipId);
    const selectedLayer = selectedHere ? (block.clipId === focusedClipId ? 240 : 230) : null;
    if (!range) return { title: block.clipId && byId.get(block.clipId)?.attrs?.['data-source-kind'] === 'take' ? '保留取用' : '原片', label: block.clipId && byId.get(block.clipId)?.attrs?.['data-source-kind'] === 'take' ? '保留取用' : '原片', previewMuted: true, zIndex: selectedLayer ?? 1, background: '#4b5563', data: { ...common, 'data-source-context': block.clipId ?? block.id } };
    const tags = range.tags ?? [];
    const highlighted = (!selectedProductId || range.productId === selectedProductId) && hasStructureTag(tags, selectedTag);
    const previewMuted = !highlighted;
    const zIndex = selectedLayer ?? (highlighted ? 15 : 10);
    const label = [displayStructureTags(tags).join(' · '), range.text].filter(Boolean).join(' · ') || '候选';
    return { title: label, label, zIndex, previewMuted, background: previewMuted ? '#4b5563' : undefined, headerBackground: previewMuted ? '#6b7280' : structureGradient(tags), headerColor: previewMuted ? '#f3f4f6' : structureColor(tags[0] ?? '').text, data: { ...common, 'data-source-candidate': range.id, 'data-source-selected': String(range.id === selectedCandidateId), 'data-source-highlighted': String(highlighted), 'data-structure-colors': '' } };
  };
  const commands = React.useRef<TimelineCommands | null>(null);
  const lecture = ranges.find(range => range.sourceId === sourceId && range.kind === 'interval' && range.id === selectedIntervalId && range.productId === selectedProductId);
  const focusLecture = () => {
    if (!lecture) return false;
    const margin = Math.max(1000, Math.min(30000, (lecture.endMs - lecture.startMs) * 0.05));
    return commands.current?.zoomRange(Math.max(0, lecture.startMs - margin), Math.min(totalMs, lecture.endMs + margin)) ?? false;
  };
  const focusKey = lecture ? `${lecture.id}:${focusRangeRequest ?? 0}` : '';
  const focusedLecture = React.useRef('');
  React.useEffect(() => {
    if (focusKey && focusedLecture.current !== focusKey && focusLecture()) focusedLecture.current = focusKey;
    // A boundary drag changes saved times, but must not zoom beneath the pointer.
  }, [focusKey, view.pxPerMs]);
  const wrapper = React.useRef<HTMLDivElement>(null);
  return <div ref={wrapper} data-source-axis="" data-source-timeline="" data-timeline-scope="source" data-source-view-start={Math.round(view.fromMs)} data-source-view-end={Math.round(view.toMs)} tabIndex={-1} className="flex min-h-0 min-w-0 flex-col" style={{ height: timelineFitHeight(tracks) + (hasProductMarkers ? 16 : 0) + 32, marginRight: rightInset }}
    onPointerDownCapture={event => { onActivate?.(); if (!(event.target as Element).closest('button,input,textarea,select,[contenteditable=true]')) event.currentTarget.focus({ preventScroll: true }); }}
    onKeyDown={event => {
      const action = keyAction(event.nativeEvent);
      const command = commands.current;
      if (action === 'undo' || action === 'redo') { event.preventDefault(); event.stopPropagation(); if (!event.repeat) step(action); return; }
      if (!command) return;
      const run = action === 'cut' ? command.cut : action === 'split' ? command.split : action === 'split-all' ? command.splitAll : action === 'zoom-fit' ? command.zoomFit : action === 'select-left' ? () => command.selectSide(-1) : action === 'select-right' ? () => command.selectSide(1) : null;
      if (run) { event.preventDefault(); event.stopPropagation(); if (!event.repeat) run(); }
    }}>
    <div className="flex h-8 shrink-0 items-center gap-2 px-3 text-[11px] text-[var(--text-muted)]" data-source-selection-summary="">
      <span className={`min-w-0 flex-1 truncate ${productFeedback?.error ? 'text-red-400' : ''}`} role={productFeedback?.error ? 'alert' : undefined} title={productFeedback?.message}>{productFeedback?.message ?? (take ? `${take.label} · ${formatTimecode(take.startMs)} – ${formatTimecode(take.endMs)}` : '选择一个片段后预览')}</span>
      <button type="button" aria-label="查看全场原片" onClick={() => commands.current?.zoomFit()} className="rounded px-2 py-1 transition hover:bg-[var(--bg-hover)] active:scale-95">全场</button>
      <button type="button" aria-label="聚焦当前商品段" disabled={!lecture} onClick={focusLecture} className="rounded px-2 py-1 transition hover:bg-[var(--bg-hover)] active:scale-95 disabled:opacity-40">当前段</button>
      <button type="button" data-source-reset-height="" title="恢复标准高度；拖动轨头底边可调整" onClick={() => { setBlockHeight(SOURCE_BLOCK_DEFAULT); try { localStorage.setItem(SOURCE_HEIGHT_KEY, JSON.stringify(SOURCE_BLOCK_DEFAULT)); } catch { /* preference applies for this session */ } }} className="rounded px-2 py-1 transition hover:bg-[var(--bg-hover)]">标准高度</button>
      <button type="button" data-source-preview-take="" disabled={!take || !onPreviewRange} onClick={() => { if (take) onPreviewRange?.(take); }} className="rounded px-2 py-1 text-[var(--text)] transition hover:bg-[var(--bg-hover)] disabled:opacity-40">预览选段</button>
    </div>
    <Timeline sourceMode commandsRef={commands} blockAppearance={appearance} blockLayout={() => ({ top: 0, height: blockHeight })} tracks={tracks} totalMs={totalMs} timeMs={time * 1000} playing={false} selectionBar={active}
      onResizeTrack={(_track, height, done) => { const next = height === null ? SOURCE_BLOCK_DEFAULT : Math.max(68, Math.min(160, Math.round(height))); setBlockHeight(next); if (done) { try { localStorage.setItem(SOURCE_HEIGHT_KEY, JSON.stringify(next)); } catch { /* preference applies for this session */ } } }}
      selected={blocks.filter(block => block.clipId && selectedClipIds.includes(block.clipId)).map(block => block.id)}
      onSelectedChange={ids => { setProductFeedback(null); const selected = blocks.filter(block => ids.includes(block.id) && block.clipId).map(block => block.clipId!); setSelectedClipIds(selected); if (selected.length) setSelectionFilterKey(filterKey); const focused = selected.length === 1 ? selected[0] : selected.find(id => !selectedClipIds.includes(id)); if (focused) setFocusedClipId(focused); }}
      onCopy={onCopySource ? blocks => onCopySource(blocks, tracks, current.current) : undefined}
      headWidth={headWidth}
      markerLane={{ shown: hasProductMarkers, render: lane => <SourceProductMarkers ranges={ranges.filter(range => range.sourceId === sourceId && range.kind === 'interval')} selectedProductId={selectedProductId} selectedIntervalId={selectedIntervalId} durationMs={totalMs} lane={lane} onSeek={onSeek} onSelectRange={onSelectRange} onTrim={onTrimProductRange} onFeedback={(message, error) => setProductFeedback({ message, error })} /> }}
      onSeek={ms => onSeek(ms / 1000)} onScrubPreview={ms => onSeek(ms / 1000)} onScrubCommit={ms => onSeek(ms / 1000)}
      thumbs={thumbs} onViewChange={setView} waveUrl={thumbnail ? () => `/api/projects/${encodeURIComponent(thumbnail.projectId)}/media?what=wave&path=${encodeURIComponent(thumbnail.path)}&v=${thumbnail.version ?? 0}` : undefined}
      onEditOps={edit} onSplit={split} onRemoveMany={blocks => edit(blocks.flatMap(b => b.clipId ? [{ op: 'remove' as const, clip: b.clipId }] : []))}
      history={{ canUndo: history.done.length > 0, canRedo: history.undone.length > 0, step }}
      onSourceSelect={block => { setProductFeedback(null); externalSelection.current = null; setSelectionRevision(value => value + 1); setFocusedClipId(block.clipId ?? null); const range = rangeFor(block); setSelectionFilterKey(JSON.stringify([range?.productId ?? selectedProductId ?? null, selectedTag])); if (range) onSelectRange?.({ ...range, startMs: block.startMs, endMs: block.endMs }); }}
      onSourceDragStart={(block, event) => {
        if (sourceTakeState(projectId, sourceId)?.error) { event.preventDefault(); return; }
        const clip = block.clipId ? byId.get(block.clipId) : undefined;
        if (!clip?.time || clip.time.length !== 2) { event.preventDefault(); return; }
        const take = { startMs: Math.round(clip.time[0] * 1000), endMs: Math.round(clip.time[1] * 1000) };
        const range = rangeFor(block);
        if (range && onDragCandidate && (!canDragCandidate || canDragCandidate(range.id))) onDragCandidate(range.id, event, take);
        else if (!range && sourceDragAvailable && onDragSourceRange) onDragSourceRange({ sourceId, ...take }, event);
        else event.preventDefault();
      }} onSourceDragEnd={onDragCandidateEnd} />
  </div>;
}
