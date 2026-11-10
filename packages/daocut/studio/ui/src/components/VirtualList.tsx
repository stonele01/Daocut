import React from 'react';

type Props<T> = {
  items: readonly T[];
  itemKey: (item: T) => string;
  estimateHeight: (item: T) => number;
  renderItem: (item: T) => React.ReactNode;
  label: string;
  maxHeight: number;
  gap?: number;
  pinnedKey?: string;
  revealKey?: string;
};

/** Variable-height cards, with only the visible rows and one screen of buffer mounted. */
export function VirtualList<T>({ items, itemKey, estimateHeight, renderItem, label, maxHeight, gap = 8, pinnedKey, revealKey }: Props<T>) {
  const root = React.useRef<HTMLDivElement>(null);
  const heights = React.useRef(new Map<string, number>());
  const pending = React.useRef(new Map<string, number>());
  const frame = React.useRef(0);
  const [revision, setRevision] = React.useState(0);
  const [view, setView] = React.useState({ top: 0, height: maxHeight });
  const layout = React.useMemo(() => {
    let top = 0;
    const index = new Map<string, number>();
    const rows = items.map((item, i) => {
      const key = itemKey(item);
      const height = heights.current.get(key) ?? estimateHeight(item);
      const row = { item, key, top, height };
      index.set(key, i); top += height + gap;
      return row;
    });
    return { rows, index, height: Math.max(0, top - gap) };
  }, [items, itemKey, estimateHeight, gap, revision]);
  const latest = React.useRef(layout); latest.current = layout;
  const measure = React.useCallback((key: string, height: number) => {
    if (!(height > 0) || heights.current.get(key) === height) return;
    pending.current.set(key, height);
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const current = latest.current, element = root.current;
      let shift = 0, changed = false;
      for (const [id, next] of pending.current) {
        const index = current.index.get(id), row = index === undefined ? undefined : current.rows[index];
        if (!row || heights.current.get(id) === next) continue;
        if (element && row.top + row.height <= element.scrollTop) shift += next - row.height;
        heights.current.set(id, next); changed = true;
      }
      pending.current.clear();
      if (changed) {
        if (element && shift) element.scrollTop += shift;
        if (element) setView({ top: element.scrollTop, height: element.clientHeight });
        setRevision(value => value + 1);
      }
    });
  }, []);
  React.useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    let previousWidth = element.clientWidth;
    const resize = new ResizeObserver(() => {
      if (element.clientWidth !== previousWidth) {
        previousWidth = element.clientWidth; heights.current.clear(); setRevision(value => value + 1);
      }
      setView({ top: element.scrollTop, height: element.clientHeight });
    });
    resize.observe(element);
    return () => { resize.disconnect(); if (frame.current) cancelAnimationFrame(frame.current); frame.current = 0; pending.current.clear(); };
  }, []);
  React.useLayoutEffect(() => {
    const element = root.current, index = revealKey === undefined ? undefined : latest.current.index.get(revealKey);
    if (!element || index === undefined) return;
    const row = latest.current.rows[index];
    if (row.top < element.scrollTop || row.top + row.height > element.scrollTop + element.clientHeight) {
      element.scrollTop = row.top;
      setView({ top: element.scrollTop, height: element.clientHeight });
    }
  }, [revealKey]);
  const from = Math.max(0, view.top - maxHeight), to = view.top + view.height + maxHeight;
  let lo = 0, hi = layout.rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1, row = layout.rows[mid];
    if (row.top + row.height < from) lo = mid + 1; else hi = mid;
  }
  const visible: typeof layout.rows = [];
  for (let i = lo; i < layout.rows.length && layout.rows[i].top <= to; i++) visible.push(layout.rows[i]);
  const pin = pinnedKey === undefined ? undefined : layout.index.get(pinnedKey);
  if (pin !== undefined && !visible.some(row => row.key === pinnedKey)) visible.push(layout.rows[pin]);
  return <div ref={root} aria-label={label} tabIndex={0} data-virtual-list="" className="min-h-0 w-full overflow-y-auto overscroll-contain" style={{ height: Math.min(maxHeight, layout.height), overflowAnchor: 'none' }} onScroll={event => setView({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })}>
    <div className="relative w-full" style={{ height: layout.height }}>
      {visible.map(row => <MeasuredRow key={row.key} rowKey={row.key} top={row.top} onMeasure={measure}>{renderItem(row.item)}</MeasuredRow>)}
    </div>
  </div>;
}

function MeasuredRow({ rowKey, top, onMeasure, children }: { rowKey: string; top: number; onMeasure: (key: string, height: number) => void; children: React.ReactNode }) {
  const root = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const measure = () => onMeasure(rowKey, Math.ceil(element.getBoundingClientRect().height));
    measure();
    const resize = new ResizeObserver(measure); resize.observe(element);
    return () => resize.disconnect();
  }, [rowKey, onMeasure]);
  return <div ref={root} data-virtual-row={rowKey} className="absolute left-0 top-0 w-full" style={{ transform: `translateY(${top}px)` }}>{children}</div>;
}
