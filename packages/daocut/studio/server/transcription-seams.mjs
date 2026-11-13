import { validateTranscriptCues } from './transcription-segments.mjs';

const normalize = text => text.replace(/[\s，。！？；、]/gu, '');
const overlaps = (a, b) => a.startMs < b.endMs && a.endMs > b.startMs;
const plain = ({ text, startMs, endMs }) => ({ text, startMs, endMs });
const reviewError = () => Object.assign(new Error('转写接缝待核对；已完成分段保留，无需重新上传音频。'), { code: 'ASR_BOUNDARY_REVIEW' });
const joinWords = words => words.reduce((text, word) => text + (/[A-Za-z]$/.test(text) && /^[A-Za-z]/.test(word.text) ? ' ' : '') + word.text, '');

// Independent recognitions often split the same sentence differently. Prefer the
// recognition furthest from its audio cut, retaining timed words outside it.
function reconcileGroup(group, before, after, wordsBySegment) {
  const sides = [before, after].map(segment => {
    const cues = group.filter(cue => cue.segmentId === segment.id).sort((a, b) => a.startMs - b.startMs);
    const padding = cues.length ? Math.min(cues[0].startMs - segment.startMs, segment.endMs - Math.max(...cues.map(cue => cue.endMs))) : -Infinity;
    return { cues, padding, owned: cues.filter(cue => cue.owned).length };
  }).sort((a, b) => b.padding - a.padding || b.owned - a.owned);
  const selected = [...sides[0].cues];
  for (const cue of sides[1].cues) {
    if (!selected.some(other => overlaps(cue, other))) { selected.push(cue); continue; }
    const remaining = (wordsBySegment.get(cue.segmentId) ?? []).filter(word => word.startMs >= cue.startMs && word.endMs <= cue.endMs && !selected.some(other => overlaps(word, other)));
    if (remaining.length) selected.push({ ...cue, text: joinWords(remaining), startMs: remaining[0].startMs, endMs: remaining.at(-1).endMs });
  }
  return selected;
}

/** Pure inspection: all provider cues remain untouched and every review time is source-absolute. */
export function inspectAudioSeams(segments, durationMs) {
  if (!Array.isArray(segments) || !segments.length || !Number.isFinite(durationMs) || durationMs <= 0) throw Error('Invalid audio segment manifest');
  const ids = new Set(), all = [], wordsBySegment = new Map();
  for (const segment of segments) {
    if (typeof segment.id !== 'string' || !segment.id || ids.has(segment.id) || ![segment.startMs, segment.endMs, segment.coreStartMs, segment.coreEndMs].every(Number.isFinite)
      || segment.startMs < 0 || segment.startMs > segment.coreStartMs || segment.coreStartMs >= segment.coreEndMs || segment.coreEndMs > segment.endMs || segment.endMs > durationMs) throw Error('Invalid audio segment range');
    ids.add(segment.id);
    wordsBySegment.set(segment.id, (segment.words ?? []).map(word => ({ text: word.token, startMs: Math.round(word.start * 1000) + segment.startMs, endMs: Math.round(word.end * 1000) + segment.startMs }))
      .filter(word => typeof word.text === 'string' && word.text.trim() && Number.isFinite(word.startMs) && Number.isFinite(word.endMs) && word.startMs >= segment.startMs && word.endMs <= segment.endMs && word.endMs > word.startMs));
    const cues = validateTranscriptCues(segment.cues, segment.endMs - segment.startMs);
    cues.forEach((cue, index) => {
      const startMs = cue.startMs + segment.startMs, endMs = cue.endMs + segment.startMs;
      all.push({ ...plain(cue), startMs, endMs, segmentId: segment.id, key: `${segment.id}:${index}`, owned: (startMs + endMs) / 2 >= segment.coreStartMs && ((startMs + endMs) / 2 < segment.coreEndMs || segment.coreEndMs === durationMs) });
    });
  }
  const seams = [], consumed = new Set(), selected = [];
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
    const proposed = [];
    for (const group of groups) {
      const exact = group.length === 2 && group[0].segmentId !== group[1].segmentId && normalize(group[0].text) === normalize(group[1].text)
        && (Math.min(group[0].endMs, group[1].endMs) - Math.max(group[0].startMs, group[1].startMs)) / Math.max(group[0].endMs - group[0].startMs, group[1].endMs - group[1].startMs) >= 0.5;
      if (exact) {
        const preferred = [...group].sort((a, b) => Number(b.owned) - Number(a.owned) || (b.endMs - b.startMs) - (a.endMs - a.startMs))[0];
        proposed.push(preferred);
      } else if (group.length === 2 && normalize(group[0].text) === normalize(group[1].text)) {
        // A tiny timestamp intersection is still two genuine short repetitions.
        proposed.push(...group);
      } else proposed.push(...reconcileGroup(group, before, after, wordsBySegment));
    }
    selected.push(...proposed);
    const startMs = Math.min(overlap.startMs, ...members.map(c => c.startMs));
    const endMs = Math.max(overlap.endMs, ...members.map(c => c.endMs));
    seams.push({ id: `${before.id}--${after.id}`, boundaryMs: after.coreStartMs, startMs, endMs, status: 'automatic',
      reason: members.length ? '已按原片时间和重叠文字自动衔接，保留两侧原始识别' : '重叠区域没有字幕',
      left: left.map(plain), right: right.map(plain), proposed: proposed.sort((a, b) => a.startMs - b.startMs).map(plain) });
  }
  const outside = all.filter(c => !consumed.has(c.key));
  const words = [...outside, ...selected].flatMap(cue => (wordsBySegment.get(cue.segmentId) ?? []).filter(word => word.startMs >= cue.startMs && word.endMs <= cue.endMs))
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  return { durationMs, seams, pendingCount: 0, outside: outside.map(plain), words };
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
