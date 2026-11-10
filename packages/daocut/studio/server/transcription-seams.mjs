import { validateTranscriptCues } from './transcription-segments.mjs';

const normalize = text => text.replace(/[\s，。！？；、]/gu, '');
const overlaps = (a, b) => a.startMs < b.endMs && a.endMs > b.startMs;
const plain = ({ text, startMs, endMs }) => ({ text, startMs, endMs });
const reviewError = () => Object.assign(new Error('转写接缝待核对；已完成分段保留，无需重新上传音频。'), { code: 'ASR_BOUNDARY_REVIEW' });

/** Pure inspection: all provider cues remain untouched and every review time is source-absolute. */
export function inspectAudioSeams(segments, durationMs) {
  if (!Array.isArray(segments) || !segments.length || !Number.isFinite(durationMs) || durationMs <= 0) throw Error('Invalid audio segment manifest');
  const ids = new Set(), all = [];
  for (const segment of segments) {
    if (typeof segment.id !== 'string' || !segment.id || ids.has(segment.id) || ![segment.startMs, segment.endMs, segment.coreStartMs, segment.coreEndMs].every(Number.isFinite)
      || segment.startMs < 0 || segment.startMs > segment.coreStartMs || segment.coreStartMs >= segment.coreEndMs || segment.coreEndMs > segment.endMs || segment.endMs > durationMs) throw Error('Invalid audio segment range');
    ids.add(segment.id);
    const cues = validateTranscriptCues(segment.cues, segment.endMs - segment.startMs);
    cues.forEach((cue, index) => {
      const startMs = cue.startMs + segment.startMs, endMs = cue.endMs + segment.startMs;
      all.push({ ...plain(cue), startMs, endMs, segmentId: segment.id, key: `${segment.id}:${index}`, owned: (startMs + endMs) / 2 >= segment.coreStartMs && ((startMs + endMs) / 2 < segment.coreEndMs || segment.coreEndMs === durationMs) });
    });
  }
  const seams = [], consumed = new Set();
  for (let index = 1; index < segments.length; index++) {
    const before = segments[index - 1], after = segments[index];
    if (before.coreEndMs !== after.coreStartMs || before.startMs >= after.startMs) throw Error('Audio segments must be contiguous and ordered');
    const overlap = { startMs: after.startMs, endMs: before.endMs };
    if (overlap.startMs > overlap.endMs) throw Error('Audio segments have a gap');
    const left = all.filter(c => c.segmentId === before.id && overlaps(c, overlap));
    const right = all.filter(c => c.segmentId === after.id && overlaps(c, overlap));
    const members = [...left, ...right].sort((a, b) => a.startMs - b.startMs);
    if (members.some(c => consumed.has(c.key))) throw reviewError();
    members.forEach(c => consumed.add(c.key));
    const groups = [];
    for (const c of members) {
      const linked = groups.filter(group => group.some(p => p.segmentId !== c.segmentId && overlaps(p, c)));
      if (!linked.length) groups.push([c]);
      else {
        const merged = [...linked.flat(), c];
        for (const group of linked) groups.splice(groups.indexOf(group), 1);
        groups.push(merged);
      }
    }
    let ambiguous = false;
    const proposed = [];
    for (const group of groups) {
      const exact = group.length === 2 && group[0].segmentId !== group[1].segmentId && normalize(group[0].text) === normalize(group[1].text)
        && (Math.min(group[0].endMs, group[1].endMs) - Math.max(group[0].startMs, group[1].startMs)) / Math.max(group[0].endMs - group[0].startMs, group[1].endMs - group[1].startMs) >= 0.5;
      if (exact) {
        const preferred = [...group].sort((a, b) => Number(b.owned) - Number(a.owned) || (b.endMs - b.startMs) - (a.endMs - a.startMs))[0];
        proposed.push(plain(preferred));
      } else if (group.length === 1 && group[0].owned) proposed.push(plain(group[0]));
      else { ambiguous = true; proposed.push(...group.filter(c => c.owned).map(plain)); }
    }
    // Same text with non-overlapping, nearby timings could be repetition or drift. Ask, never deduplicate it.
    if (left.some(a => right.some(b => normalize(a.text) === normalize(b.text) && !overlaps(a, b)))) ambiguous = true;
    if (members.length && (!left.length || !right.length)) ambiguous = true;
    const startMs = Math.min(overlap.startMs, ...members.map(c => c.startMs));
    const endMs = Math.max(overlap.endMs, ...members.map(c => c.endMs));
    seams.push({ id: `${before.id}--${after.id}`, boundaryMs: after.coreStartMs, startMs, endMs, status: ambiguous ? 'pending' : 'automatic',
      reason: ambiguous ? '两侧文字、分句或时间不一致，请听原片核对' : members.length ? '重叠文字一致，已按原片时间去重' : '重叠区域没有字幕',
      left: left.map(plain), right: right.map(plain), proposed: proposed.sort((a, b) => a.startMs - b.startMs) });
  }
  return { durationMs, seams, pendingCount: seams.filter(s => s.status === 'pending').length, outside: all.filter(c => !consumed.has(c.key)).map(plain) };
}

export function validateSeamResolution(seam, cues) {
  if (!Array.isArray(cues)) throw Error('接缝修订必须是字幕列表');
  if (cues.length) validateTranscriptCues(cues, seam.endMs);
  if (cues.some(c => c.startMs < seam.startMs || c.endMs > seam.endMs)) throw Error('修订字幕超出本接缝核对范围');
  return cues.map(plain);
}

export function resolveAudioSeams(inspection, resolutions) {
  const cues = [...inspection.outside];
  for (const seam of inspection.seams) {
    const resolved = Object.hasOwn(resolutions, seam.id) ? validateSeamResolution(seam, resolutions[seam.id]) : null;
    if (!resolved && seam.status === 'pending') throw reviewError();
    cues.push(...(resolved ?? seam.proposed));
  }
  cues.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  return validateTranscriptCues(cues, inspection.durationMs);
}
