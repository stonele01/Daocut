import type { TimelineBlock, TimelineTrack } from './timeline-layout';

export type SourceOverlap = { startMs: number; endMs: number; blockIds: string[] };

/** One source row; report only the intervals where at least two actual clips overlap. */
export function stackSourceTracks(rows: readonly TimelineTrack[], blockHeight: number): { tracks: TimelineTrack[]; overlaps: Set<string>; segments: SourceOverlap[] } {
  if (!rows.length) return { tracks: [], overlaps: new Set(), segments: [] };
  const blocks = rows.flatMap(row => row.blocks).sort((a: TimelineBlock, b: TimelineBlock) =>
    a.startMs - b.startMs || a.endMs - b.endMs || (a.clipId ?? a.id).localeCompare(b.clipId ?? b.id));
  const events = blocks.flatMap(block => [{ time: block.startMs, id: block.id, start: true }, { time: block.endMs, id: block.id, start: false }]).sort((a, b) => a.time - b.time || Number(a.start) - Number(b.start));
  const active = new Set<string>();
  const overlaps = new Set<string>();
  const segments: SourceOverlap[] = [];
  let previous = events[0]?.time ?? 0;
  for (let i = 0; i < events.length;) {
    const time = events[i].time;
    if (time > previous && active.size > 1) {
      const blockIds = [...active].sort();
      blockIds.forEach(id => overlaps.add(id));
      const last = segments[segments.length - 1];
      if (last && last.endMs === previous && last.blockIds.join('\0') === blockIds.join('\0')) last.endMs = time;
      else segments.push({ startMs: previous, endMs: time, blockIds });
    }
    while (i < events.length && events[i].time === time) {
      const event = events[i++];
      if (event.start) active.add(event.id); else active.delete(event.id);
    }
    previous = time;
  }
  return { tracks: [{ ...rows[0], index: 1, name: '原片素材', badge: undefined, blocks, height: blockHeight }], overlaps, segments };
}
