import type { Clip, Film } from '../api';
import type { SourceProductRange } from '../components/SourcePreview';

const BASE_START = 'data-source-base-start';
const BASE_END = 'data-source-base-end';
const EDITED = 'data-source-edited';
const DELETED = 'data-source-deleted-candidates';
const candidateId = (clip: Clip) => clip.attrs?.['data-source-range'] ?? '';
const bounds = (clip: Clip) => clip.time?.length === 2 ? [Math.round(clip.time[0] * 1000), Math.round(clip.time[1] * 1000)] as const : null;
const origin = (clip: Clip) => {
  const start = Number(clip.attrs?.[BASE_START]), end = Number(clip.attrs?.[BASE_END]);
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? [start, end] as const : null;
};
function withOrigin(clip: Clip, start: number, end: number): Clip {
  return { ...clip, attrs: { ...clip.attrs, [BASE_START]: String(start), [BASE_END]: String(end) } };
}

/** A private editable copy: source coordinates are both timeline positions and media in points. */
export function sourceFilm(sourceId: string, src: string, durationMs: number, ranges: readonly SourceProductRange[], takes: Record<string, { startMs: number; endMs: number }> = {}): Film {
  durationMs = Number.isFinite(durationMs) ? Math.max(0, Math.floor(durationMs)) : 0;
  const candidates = ranges.filter(r => r.sourceId === sourceId && r.kind === 'candidate' && Number.isFinite(r.startMs) && Number.isFinite(r.endMs) && r.endMs > r.startMs)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const pieces: { start: number; end: number; range?: SourceProductRange }[] = [];
  let cursor = 0;
  for (const range of candidates) {
    const start = Math.max(0, Math.min(durationMs, range.startMs));
    const end = Math.max(start, Math.min(durationMs, range.endMs));
    if (start > cursor) pieces.push({ start: cursor, end: start });
    cursor = Math.max(cursor, end);
    if (end > start) pieces.push({ start, end, range });
  }
  if (cursor < durationMs) pieces.push({ start: cursor, end: durationMs });
  const clips = pieces.map((piece, i) => {
    const key = `${sourceId}:${piece.range ? 'candidate' : 'context'}:${piece.range?.id ?? ''}:${piece.start}:${piece.end}`;
    const take = takes[key];
    const valid = take && Number.isFinite(take.startMs) && Number.isFinite(take.endMs) && take.startMs >= 0 && take.endMs > take.startMs && take.endMs <= durationMs && Math.round(take.endMs) > Math.round(take.startMs);
    const start = Math.round(valid ? take.startMs : piece.start);
    const end = Math.round(valid ? take.endMs : piece.end);
    return withOrigin({ id: `source-${i}`, src, at: start / 1000, time: [start / 1000, end / 1000], attrs: { 'data-source-range': piece.range?.id ?? '', 'data-source-kind': piece.range ? 'candidate' : 'context' } }, Math.round(piece.start), Math.round(piece.end));
  });
  // Keep the original clock: a shorter personal take leaves an intentional gap.
  return { tracks: [{ clips: clips.filter(clip => clip.time && clip.time[1]! > clip.time[0]) }] };
}

function isEdited(clips: Clip[]): boolean {
  if (clips.length !== 1) return true;
  const clip = clips[0], original = origin(clip), current = bounds(clip);
  return clip.attrs?.[EDITED] === 'true' || !original || !current || original[0] !== current[0] || original[1] !== current[1]
    || Object.keys(clip).some(key => !['id', 'src', 'at', 'time', 'attrs'].includes(key))
    || Object.keys(clip.attrs ?? {}).some(key => !key.startsWith('data-source-'));
}

/** Rebase AI suggestions while retaining personal decisions, including deleted blocks and gray gaps.
 * `previous` is the unedited film generated from the last saved analysis signature, not the edited film.
 * Origins survive rebases so a trim does not become an unedited suggestion on a later rerun. */
export function reconcileSourceFilm(fresh: Film, saved: Film, previous: Film): Film {
  const oldBase = previous.tracks.flatMap(track => track.clips);
  const previousIds = new Set(oldBase.map(candidateId).filter(Boolean));
  const existing = structuredClone(saved.tracks.flatMap(track => track.clips)).map(clip => {
    if (origin(clip)) return clip;
    // Import older localStorage takes. Split halves inherit the old block's attrs and id stem.
    const base = candidateId(clip) ? oldBase.find(old => candidateId(old) === candidateId(clip))
      : oldBase.find(old => !candidateId(old) && (clip.id === old.id || clip.id.startsWith(`${old.id}-b`)));
    const original = base && bounds(base);
    return original ? withOrigin(clip, original[0], original[1]) : { ...clip, attrs: { ...clip.attrs, [EDITED]: 'true' } };
  });
  const nextCandidates = structuredClone(fresh.tracks.flatMap(track => track.clips).filter(clip => candidateId(clip)));
  const nextIds = new Set(nextCandidates.map(candidateId));
  const deleted = new Set<string>();
  for (const track of saved.tracks) {
    try { const ids: unknown = JSON.parse(track.attrs?.[DELETED] ?? '[]'); if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string') deleted.add(id); } catch { /* legacy track without deletion history */ }
  }
  const groups = new Map<string, Clip[]>();
  for (const clip of existing) {
    const id = candidateId(clip);
    if (id) groups.set(id, [...(groups.get(id) ?? []), clip]);
  }
  for (const id of previousIds) if (!groups.has(id)) deleted.add(id);
  for (const id of groups.keys()) deleted.delete(id);

  const clips: Clip[] = [];
  for (const next of nextCandidates) {
    const id = candidateId(next), kept = groups.get(id);
    if (deleted.has(id)) continue;
    if (kept && isEdited(kept)) clips.push(...kept.map(clip => ({ ...clip, attrs: { ...clip.attrs, [EDITED]: 'true' } })));
    else clips.push(next);
  }
  for (const [id, kept] of groups) {
    if (nextIds.has(id) || !isEdited(kept)) continue;
    // A removed AI identity cannot supply current tags/evidence. Its personal take remains usable.
    clips.push(...kept.map(clip => ({ ...clip, attrs: { ...clip.attrs, 'data-source-range': '', 'data-source-kind': 'take', 'data-source-origin-range': id, [EDITED]: 'true' } })));
  }
  for (const clip of existing.filter(item => !candidateId(item))) {
    if (clip.attrs?.['data-source-kind'] === 'take' || isEdited([clip])) {
      clips.push({ ...clip, attrs: { ...clip.attrs, [EDITED]: 'true' } });
      continue;
    }
    const range = bounds(clip);
    if (!range) continue;
    // Only untouched gray footage is carved for new suggestions. Never regenerate gray blocks:
    // a trim/delete is an intentional hole, even when a later analysis removes a candidate.
    let pieces: (readonly [number, number])[] = [range];
    for (const candidate of nextCandidates) {
      const cut = bounds(candidate);
      if (!cut) continue;
      pieces = pieces.flatMap(([start, end]) => cut[1] <= start || cut[0] >= end ? [[start, end] as const]
        : [...(start < cut[0] ? [[start, cut[0]] as const] : []), ...(cut[1] < end ? [[cut[1], end] as const] : [])]);
    }
    clips.push(...pieces.map(([start, end], index) => withOrigin({ ...clip, id: index ? `${clip.id}-part-${index}` : clip.id, at: start / 1000, time: [start / 1000, end / 1000] }, start, end)));
  }
  clips.sort((a, b) => (a.time?.[0] ?? 0) - (b.time?.[0] ?? 0) || a.id.localeCompare(b.id));
  const ids = new Set<string>();
  for (const clip of clips) {
    let id = clip.id;
    while (ids.has(id)) id += '-b';
    clip.id = id; ids.add(id);
  }
  return { ...structuredClone(saved), tracks: [{ ...saved.tracks[0], attrs: { ...saved.tracks[0]?.attrs, [DELETED]: JSON.stringify([...deleted].sort()) }, clips }] };
}

/** Buttons, previews and drags use the same retained take; a deleted candidate has no fallback. */
export function resolveCandidateTake(film: Film, id: string, focusedClipId?: string | null): { clipId: string; startMs: number; endMs: number } | null {
  const clips = film.tracks.flatMap(track => track.clips).filter(clip => candidateId(clip) === id && bounds(clip));
  const selected = clips.find(clip => clip.id === focusedClipId) ?? clips.sort((a, b) => a.time![0] - b.time![0] || a.id.localeCompare(b.id))[0];
  const range = selected && bounds(selected);
  return range ? { clipId: selected.id, startMs: range[0], endMs: range[1] } : null;
}
