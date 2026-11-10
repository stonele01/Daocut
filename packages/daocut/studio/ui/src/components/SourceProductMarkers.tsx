import React from 'react';
import { sourceTime } from '@/lib/product-analysis';
import type { SourceProductRange } from './SourcePreview';
import type { MarkerLaneView } from './Timeline';

type Bounds = { startMs: number; endMs: number };
type Props = {
  ranges: SourceProductRange[];
  selectedProductId?: string | null;
  selectedIntervalId?: string | null;
  durationMs: number;
  lane: MarkerLaneView;
  onSeek: (seconds: number) => void;
  onSelectRange?: (range: SourceProductRange) => void;
  onTrim?: (range: SourceProductRange, bounds: Bounds) => Promise<void>;
  onFeedback: (message: string, error?: boolean) => void;
};

/** Product lecture bounds belong to the project, independently of the private source takes below. */
export function SourceProductMarkers(props: Props) {
  const { ranges, selectedProductId, selectedIntervalId, lane, onSelectRange, onSeek, onTrim, durationMs, onFeedback } = props;
  const root = React.useRef<HTMLDivElement>(null);
  const [draft, setDraft] = React.useState<(Bounds & { id: string }) | null>(null);
  const [saving, setSaving] = React.useState(false);
  const busy = React.useRef(false);
  const cleanup = React.useRef<(() => void) | null>(null);
  const latest = React.useRef(props); latest.current = props;
  React.useEffect(() => () => { cleanup.current?.(); latest.current.lane.guide(null); }, []);

  const press = (event: React.PointerEvent<HTMLButtonElement>, range: SourceProductRange, edge: 'start' | 'end') => {
    event.stopPropagation();
    if (event.button !== 0 || !onTrim || busy.current || cleanup.current || !root.current || !(lane.pxPerMs > 0) || durationMs < 1) return;
    event.preventDefault();
    const target = event.currentTarget, pointerId = event.pointerId;
    const pxPerMs = lane.pxPerMs;
    const startPointerMs = (event.clientX - root.current.getBoundingClientRect().left) / pxPerMs;
    const initial = { ...range };
    const originalEdge = edge === 'start' ? initial.startMs : initial.endMs;
    let next: Bounds = { startMs: initial.startMs, endMs: initial.endMs };
    let moved = false;
    const show = () => {
      setDraft({ id: initial.id, ...next });
      const ms = edge === 'start' ? next.startMs : next.endMs;
      lane.guide({ ms, color: '#2563eb', held: true });
      onFeedback(`商品讲解 · ${range.text ?? '商品'} · ${sourceTime(next.startMs)} – ${sourceTime(next.endMs)}`);
      onSeek(ms / 1000);
    };
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId || !root.current) return;
      const delta = (ev.clientX - root.current.getBoundingClientRect().left) / pxPerMs - startPointerMs;
      // Do not snap to the preview playhead: it follows this edge and would hold the next pointer move in place.
      const ms = Math.round(originalEdge + delta);
      next = edge === 'start'
        ? { startMs: Math.max(0, Math.min(initial.endMs - 1, ms)), endMs: initial.endMs }
        : { startMs: initial.startMs, endMs: Math.max(initial.startMs + 1, Math.min(Math.floor(durationMs), ms)) };
      moved = moved || next.startMs !== initial.startMs || next.endMs !== initial.endMs;
      show();
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancelPointer);
      window.removeEventListener('keydown', key, true);
      target.removeEventListener('lostpointercapture', cancelPointer);
      cleanup.current = null;
      try { if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId); } catch { /* The source may have been closed. */ }
      lane.guide(null);
    };
    const cancel = () => {
      stop(); setDraft(null);
      onFeedback('已取消商品边界调整');
      onSeek(originalEdge / 1000);
    };
    const cancelPointer = (ev: PointerEvent) => { if (ev.pointerId === pointerId) cancel(); };
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault(); ev.stopImmediatePropagation(); cancel();
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      if (moved) move(ev);
      stop();
      if (next.startMs === initial.startMs && next.endMs === initial.endMs) { setDraft(null); onFeedback('商品讲解范围未变化'); return; }
      busy.current = true; setSaving(true);
      onFeedback('正在保存商品讲解范围…');
      void onTrim(initial, next).then(() => {
        onFeedback('商品讲解范围已保存');
      }).catch((error: unknown) => {
        onFeedback(`商品讲解范围未保存：${error instanceof Error ? error.message : String(error)}`, true);
        onSeek(originalEdge / 1000);
      }).finally(() => { busy.current = false; setSaving(false); setDraft(null); });
    };
    cleanup.current = stop;
    target.focus({ preventScroll: true });
    try { target.setPointerCapture(pointerId); } catch { /* Window listeners still receive the gesture. */ }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancelPointer);
    window.addEventListener('keydown', key, true);
    target.addEventListener('lostpointercapture', cancelPointer);
    show();
  };

  return <div ref={root} className="pointer-events-none absolute inset-0" data-product-markers="">
    {ranges.map(range => {
      const bounds = draft?.id === range.id ? draft : range;
      const overscan = Math.max(0, lane.toMs - lane.fromMs) / 2;
      if (draft?.id !== range.id && (bounds.endMs < lane.fromMs - overscan || bounds.startMs > lane.toMs + overscan)) return null;
      const selected = range.productId === selectedProductId;
      const active = selected && range.id === selectedIntervalId;
      const width = Math.max(2, (bounds.endMs - bounds.startMs) * lane.pxPerMs);
      return <div key={range.id} data-marker="" data-source-product-range={range.id} data-product-start-ms={bounds.startMs} data-product-end-ms={bounds.endMs}
        className={`pointer-events-auto absolute inset-y-0 rounded-sm border text-[10px] transition-colors ${active ? 'border-blue-700 bg-blue-600 text-white ring-1 ring-inset ring-blue-200' : selected ? 'border-blue-500 bg-blue-200 text-blue-950' : 'border-blue-300 bg-blue-100 text-blue-900'}`}
        style={{ left: bounds.startMs * lane.pxPerMs, width, zIndex: draft?.id === range.id ? 5 : active ? 4 : selected ? 3 : 2 }}
        title={`商品讲解 · ${range.text ?? '商品'} · ${sourceTime(bounds.startMs)} – ${sourceTime(bounds.endMs)}`}
        onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
        <button type="button" className={`absolute inset-y-0 ${width >= 18 ? 'left-2 right-2' : 'inset-x-0'} truncate text-left leading-none transition-colors active:opacity-70 ${active ? 'hover:text-blue-100' : 'hover:text-blue-600'}`}
          aria-label={`定位商品讲解 ${range.text ?? '商品'} ${sourceTime(range.startMs)} – ${sourceTime(range.endMs)}`}
          aria-pressed={active}
          onClick={() => { if (busy.current || cleanup.current) return; onSelectRange?.(range); onSeek(range.startMs / 1000); }}>{range.text ?? '商品'}</button>
        {onTrim && width >= 18 && (['start', 'end'] as const).map(edge => <button type="button" key={edge} data-product-trim={edge}
          aria-label={`调整商品讲解${edge === 'start' ? '起点' : '终点'} ${range.text ?? '商品'}`}
          disabled={saving} onPointerDown={event => press(event, range, edge)}
          className={`absolute inset-y-0 flex w-2 touch-none cursor-ew-resize items-center justify-center rounded-sm transition-colors hover:bg-blue-500/40 active:bg-blue-600/50 disabled:cursor-wait ${edge === 'start' ? 'left-0' : 'right-0'}`}>
          <span aria-hidden className={`h-2.5 w-0.5 rounded-full ${active ? 'bg-white' : 'bg-blue-700'}`} />
        </button>)}
      </div>;
    })}
  </div>;
}
