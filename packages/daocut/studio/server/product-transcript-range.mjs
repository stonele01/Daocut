import { HttpError } from './http.mjs';
import { validateTranscriptCues } from './transcription-segments.mjs';

const segment = ({ startMs, endMs, text }) => ({ startMs, endMs, text });
const overlaps = (a, b) => a.startMs < b.endMs && a.endMs > b.startMs;
const contains = (outer, inner) => inner.startMs >= outer.startMs && inner.endMs <= outer.endMs;
const joinWords = words => words.reduce((text, word) => text + (/[A-Za-z]$/.test(text) && /^[A-Za-z]/.test(word.text) ? ' ' : '') + word.text, '');
const boundaryError = () => new HttpError(409, '商品段边界切在字幕中间，但没有可靠的逐词时间可裁切。请将边界调整到字幕句边后再分析；未发起转写。');

/** Both the card task and scoped chat use this exact, source-absolute selection. */
export function productTranscriptRange(transcript, scope, durationMs) {
  if (!transcript) throw new HttpError(409, '当前素材没有可用的已保存转写，请先完成或确认转写；未发起转写。');
  let cues;
  try { cues = validateTranscriptCues(transcript.cues?.length ? transcript.cues : transcript.words, durationMs); }
  catch { throw new HttpError(409, '已保存转写的时间或内容无效，无法分析所选商品段。'); }
  let words, omittedBoundaryWords = 0;
  const segments = [], cueIndices = [];
  for (let index = 0; index < cues.length; index++) {
    const cue = cues[index];
    if (!overlaps(scope, cue)) continue;
    if (contains(scope, cue)) { segments.push(segment(cue)); cueIndices.push(index); continue; }
    if (transcript.unalignedRanges?.some(range => overlaps(cue, range))) throw new HttpError(409, '商品段边界切在人工修订的字幕中间，旧逐词时间不再可靠。请将边界调整到该句起止位置后再分析；未发起转写。');
    if (!words) {
      try { words = validateTranscriptCues(transcript.words, durationMs); }
      catch { throw boundaryError(); }
    }
    const cueWords = words.filter(word => overlaps(cue, word));
    if (!cueWords.length || cueWords.some(word => !contains(cue, word))) throw boundaryError();
    const inRange = cueWords.filter(word => contains(scope, word));
    omittedBoundaryWords += cueWords.filter(word => overlaps(scope, word) && !contains(scope, word)).length;
    if (inRange.length) {
      segments.push({ startMs: inRange[0].startMs, endMs: inRange.at(-1).endMs, text: joinWords(inRange) });
      cueIndices.push(index);
    }
  }
  if (!segments.length) throw new HttpError(409, '所选商品段内没有完整、有效的字幕或词，请调整边界；未发起转写。');
  return { cues, segments, cueIndices, omittedBoundaryWords };
}
