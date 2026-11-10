import { inspectAudioSeams, resolveAudioSeams } from './transcription-seams.mjs';
// Audio windows are independent of text/model windows. All persisted times are source milliseconds.
export const AUDIO_SEGMENT_POLICY = { version: 'audio-window-v1', targetMs: 20 * 60_000, overlapMs: 10_000 };

export function planAudioSegments(durationMs, { targetMs = AUDIO_SEGMENT_POLICY.targetMs, overlapMs = AUDIO_SEGMENT_POLICY.overlapMs } = {}) {
  if (!Number.isFinite(durationMs) || durationMs <= 0 || !Number.isFinite(targetMs) || targetMs <= 0 || !Number.isFinite(overlapMs) || overlapMs < 0 || overlapMs >= targetMs) throw new Error('Invalid audio segmentation policy.');
  const segments = [];
  for (let at = 0; at < durationMs; at += targetMs) {
    const end = Math.min(durationMs, at + targetMs);
    segments.push({ id: `audio-${segments.length + 1}`, coreStartMs: at, coreEndMs: end, startMs: Math.max(0, at - overlapMs / 2), endMs: Math.min(durationMs, end + overlapMs / 2) });
  }
  return segments;
}

export function validateTranscriptCues(cues, durationMs = Infinity) {
  if (!Array.isArray(cues) || !cues.length || cues.some((c, i) => !c || typeof c.text !== 'string' || !c.text.trim() || !Number.isFinite(c.startMs) || !Number.isFinite(c.endMs) || c.startMs < 0 || c.startMs >= c.endMs || c.endMs > durationMs || (i && c.startMs < cues[i - 1].startMs))) throw new Error('Transcription has no valid sentence timestamps; sentence-level location is unavailable.');
  return cues;
}

/** Inspect every seam before publishing; ambiguous results stay in the raw manifest for local review. */
export function mergeAudioSegments(segments, durationMs) {
  return resolveAudioSeams(inspectAudioSeams(segments, durationMs), {});
}
